import { ref, type Ref } from "vue";
import { presetLabel, type CwdPreset } from "../components/presets";
import type { Launcher } from "../components/launchers";
import { isCustomAgent, type CustomAgent } from "../../common/customAgents";
import type { UserMcpServer } from "../components/userMcp";
import type { QuickCommand } from "../../common/quickCommands";
import { isToolbarLink, type ToolbarLink } from "../../common/toolbarLinks";
import { isPushKind, type PushKind } from "../../common/pushKinds";
import { DEFAULT_SOUND_KINDS, isNotifyKind, type NotifyKind } from "../../common/notifyKinds";
import { isRecord } from "../../common/isRecord";
import { isUnknownArray } from "../../common/isUnknownArray";
import { readSoundMap, type SoundMap } from "./soundSettings";
import type { SoundConfig } from "./useAttentionSound";
import { DEFAULT_TERMINAL_SUBMIT_MODE, isTerminalSubmitMode } from "../../common/terminalSubmit";
import { setTerminalSubmitMode } from "./terminalSubmitMode";
import { setGlobalFontFamily } from "./terminalFontFamily";
import { setCustomThemes } from "./customThemes";
import { refreshTheme } from "./useTheme";
import { setActiveKeymap } from "./activeKeymap";
import { setCockpitLines } from "./cockpitLines";
import { setCopyOnSelect } from "./copyOnSelect";
import { setIssueWorkComments } from "./issueWorkComments";
import { setPrWorkdirFooter } from "./prWorkdirFooter";
import { setAppendSystemPrompt } from "./appendSystemPrompt";
import { setDecisionDigest } from "./decisionDigest";
import { setWorklogEnabled, setWorklogIntervalHours } from "./worklog";
import { setHeaderConfigSummary } from "./headerConfigSummary";
import { postConfigField } from "./postConfigField";
import { fetchWithTimeout } from "../utils/fetchWithTimeout";

// The custom attention-sound file is a SINGLETON ref shared across every
// useAppConfig() caller — the beep player lives in the single view while the
// settings modal can be opened from either view, so a change in one must reach the
// other (each useAppConfig() otherwise has its own local refs).
const soundFile = ref<string | null>(null);

// Whether the server sends a Web Push when a task finishes — a SINGLETON like the
// others so the settings toggle (openable from either view) reflects the saved state.
// The actual sending is server-side; the client only reads/writes this flag.
const pushEnabled = ref(false);

// Which kinds of push the server sends (#850) — SINGLETON like the others.
const pushKinds = ref<PushKind[]>([]);

// Which moments beep, and what each one plays (#873) — SINGLETONS like the others, since the
// beep player lives in the single view while the settings modal opens from either.
const soundKinds = ref<NotifyKind[]>([...DEFAULT_SOUND_KINDS]);
const sounds = ref<SoundMap>({});

/** The sound settings as the player wants them. Module-level rather than a useAppConfig()
 *  field so a one-off notification can read them without building per-call config state. */
export const currentSoundConfig = (): SoundConfig => ({ kinds: soundKinds.value, sounds: sounds.value, soundFile: soundFile.value });

// Adopt the sound settings from a /api/config response. Module-level so loadConfig stays a
// readable list of assignments rather than growing a third ternary per field.
function adoptSoundConfig(c: Record<string, unknown>): void {
  soundFile.value = typeof c.soundFile === "string" ? c.soundFile : null;
  // A config written before #873 has no soundKinds; the defaults keep it beeping exactly as it
  // did rather than going silent on upgrade.
  soundKinds.value = Array.isArray(c.soundKinds) ? c.soundKinds.filter(isNotifyKind) : [...DEFAULT_SOUND_KINDS];
  sounds.value = isRecord(c.sounds) ? readSoundMap(c.sounds) : {};
}

// Cross-repo PR list's repos — also a SINGLETON, so the settings modal (openable from
// either view) and any future reader share one list; a save in one view is seen by the
// other instead of each useAppConfig() keeping a divergent copy.
// The server's home directory, used to shorten paths for display (`formatCwd`). A SINGLETON like
// the settings below, and for a sharper reason: it is only ever written by `loadConfig`, so a
// component that calls useAppConfig() WITHOUT calling loadConfig — which anything outside the two
// views does — held its own copy that stayed null forever, and every path it showed came out
// unshortened. Found by looking at a screenshot of the issue rows' clone menu.
const home = ref<string | null>(null);

/** The server's home directory, for a reader outside the composable — null until the config
 *  has loaded. Same shape as `currentSoundConfig` above. */
export const currentHome = (): string | null => home.value;

const prRepos = ref<string[]>([]);

// The hosts declared as self-hosted GitLab (#1332). The browser needs it to know that a
// `gitlab.hogefuga.com/...` row can start work, which is a decision this side makes on its own
// (common/issueStartPlan.ts), and Settings now edits it too.
const gitlabHosts = ref<string[]>([]);

/** The declared hosts, for a reader outside the composable — same shape as `currentSoundConfig`
 *  above, and for the same reason: useAppConfig() builds per-call refs, so calling it from a
 *  render path to read one singleton is waste. Reading `.value` here still tracks the dependency,
 *  so a computed that calls this re-runs when the config lands. */
export const currentGitlabHosts = (): string[] => gitlabHosts.value;

// Which clone each repo's work starts in (#1172) — a SINGLETON for the same reason, and read from
// the CONFIG rather than reconstructed from /api/repo-dirs: that view drops a recording whose
// directory it cannot currently see, so merging a new choice into it would quietly delete the
// choice for a clone that happens to be on an unmounted volume today.
const repoDirs = ref<Record<string, string>>({});

// Cell-launcher commands (shell/codex/…) — SINGLETON so the grid's cell launchers and
// the settings editor (openable from either view) share one list.
const launchers = ref<Launcher[]>([]);

// The user's own ways of starting Claude Code, offered in the Agent Picker (#1414) — a SINGLETON
// like the launchers above, and read-only here: config.json is the only place they can be set.
const customAgents = ref<CustomAgent[]>([]);

// User-added HTTP MCP servers merged into the single-view session's --mcp-config —
// SINGLETON like the others.
const userMcpServers = ref<UserMcpServer[]>([]);

// The phrases the phone offers as chips on a session (#830) — SINGLETON like the others, so
// the settings editor and any future in-app use read one list.
const quickCommands = ref<QuickCommand[]>([]);
// Read-only, unlike the lists above it: the settings UI does not edit these, so there is no
// setter and no POST — config.json (or a POST to /api/config) is where they are named.
const toolbarLinks = ref<ToolbarLink[]>([]);

// Pre-#163 recent dirs lived in localStorage (the removed useRecentDirs). They are
// imported once into the server-side preset list on load — see migrateLegacyRecents.
const LEGACY_RECENTS_KEY = "recent_dirs_v1";

function readLegacyRecents(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string" && d.length > 0) : [];
  } catch {
    return [];
  }
}

// The elements of a config list that pass their own guard. Anything else is dropped rather than
// loaded: the list is a set of independent entries, so one bad entry costs only itself.
const listOf = <T>(value: unknown, isEntry: (entry: unknown) => entry is T): T[] => (isUnknownArray(value) ? value.filter(isEntry) : []);

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const isCwdPreset = (value: unknown): value is CwdPreset => isRecord(value) && typeof value.label === "string" && typeof value.path === "string";
const isQuickCommand = (value: unknown): value is QuickCommand => isRecord(value) && typeof value.label === "string" && typeof value.text === "string";
const isUserMcpServer = (value: unknown): value is UserMcpServer => isRecord(value) && typeof value.id === "string" && typeof value.url === "string";
const isLauncher = (value: unknown): value is Launcher => isRecord(value) && typeof value.label === "string" && typeof value.command === "string";

// The record/remove/migrate preset mutations. Each preset write POSTs the whole array, so
// concurrent record/remove calls (two grid cells launching at once) must not each derive
// `next` from the same stale snapshot — the later POST would clobber the earlier one
// (last-write-wins, dropping a just-launched dir). `serialize` runs the writes in order so
// every mutation reads the freshly-saved list before computing its own.
function createPresetMutations(presets: Ref<CwdPreset[]>, savePresets: (next: CwdPreset[]) => Promise<boolean>) {
  let presetWrite: Promise<unknown> = Promise.resolve();
  function serialize(mutate: () => Promise<void>): Promise<void> {
    const run = presetWrite.then(mutate, mutate);
    presetWrite = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // Auto-add the dir the user just launched in, so it becomes a one-click chip, and move it
  // to the FRONT (most-recently-used) on every launch so the list reflects launch order. A
  // re-launched dir keeps its existing (possibly manual) label; a new dir is prepended with
  // its basename. Already at the front → no write. No cap: the user prunes the list with the
  // chip's close button. Called with the server-confirmed (effective) cwd so we only remember dirs that
  // actually ran.
  function recordPreset(path: string | null): Promise<void> {
    if (!path) return Promise.resolve();
    return serialize(async () => {
      if (presets.value[0]?.path === path) return; // already most-recent — nothing to reorder
      const existing = presets.value.find((p) => p.path === path);
      const entry = existing ?? { label: presetLabel(path), path };
      await savePresets([entry, ...presets.value.filter((p) => p.path !== path)]);
    });
  }

  // Drop one preset (the chip's close button). No-op when the path isn't present.
  function removePreset(path: string): Promise<void> {
    return serialize(async () => {
      if (!presets.value.some((p) => p.path === path)) return;
      await savePresets(presets.value.filter((p) => p.path !== path));
    });
  }

  // One-time import of the pre-#163 localStorage recents so upgrading users keep their recent
  // dirs as chips. New paths are prepended (most-recent first) so the last-used dir stays at
  // the front — consistent with the MRU ordering; their basename is the label. The legacy key
  // is cleared on success so a chip the user later deletes can't reappear. Dedup keeps it
  // harmless if it runs twice.
  async function migrateLegacyRecents(): Promise<void> {
    const legacy = readLegacyRecents();
    if (!legacy.length) return;
    const known = new Set(presets.value.map((p) => p.path));
    const additions = legacy.filter((path) => !known.has(path)).map((path) => ({ label: presetLabel(path), path }));
    let saved = true;
    if (additions.length) {
      await serialize(async () => {
        saved = await savePresets([...additions, ...presets.value]);
      });
    }
    if (!saved) return; // keep the key so the import retries on the next load
    try {
      localStorage.removeItem(LEGACY_RECENTS_KEY);
    } catch {
      // storage blocked — dedup makes a retry harmless
    }
  }

  return { recordPreset, removePreset, migrateLegacyRecents };
}

// The directory-preset subsystem: savePresets + the mutations above, owning the version
// coordination with loadConfig. `version` is bumped by every local preset write; loadConfig
// captures it (snapshotVersion) before its GET and adoptServerPresets skips the server list
// if it changed meanwhile — else a dir the user launched before the initial /api/config
// resolves would be dropped by the stale GET.
function createPresetManager(presets: Ref<CwdPreset[]>, saving: Ref<boolean>, error: Ref<string | null>) {
  let version = 0;

  // Persist the directory presets. Posts only cwdPresets — the server keeps the other fields,
  // so this never clobbers them. Returns whether the save succeeded.
  async function savePresets(next: CwdPreset[]): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      const res = await fetchWithTimeout("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwdPresets: next }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      const saved: unknown = await res.json();
      presets.value = isRecord(saved) && isUnknownArray(saved.cwdPresets) ? saved.cwdPresets.filter(isCwdPreset) : [];
      version++;
      return true;
    } catch {
      error.value = "Couldn't save presets. Check the server and try again.";
      return false;
    } finally {
      saving.value = false;
    }
  }

  const snapshotVersion = (): number => version;
  const adoptServerPresets = (list: unknown, capturedVersion: number): void => {
    if (version === capturedVersion) presets.value = isUnknownArray(list) ? list.filter(isCwdPreset) : [];
  };

  return { savePresets, ...createPresetMutations(presets, savePresets), snapshotVersion, adoptServerPresets };
}

// The single-field savers each persist ONE config field and update its SINGLETON ref, so
// they're module-level (no per-composable state) — useAppConfig just re-exports them.
// Persist just the custom attention sound (a file path, or null to use the chime).
async function saveSound(file: string | null): Promise<boolean> {
  const r = await postConfigField("soundFile", file);
  if (r.ok) soundFile.value = typeof r.value === "string" ? r.value : null;
  return r.ok;
}
// Persist the "send a Web Push on task finish" toggle (partial update).
async function savePushEnabled(on: boolean): Promise<boolean> {
  const r = await postConfigField("pushEnabled", on);
  if (r.ok) pushEnabled.value = r.value === true;
  return r.ok;
}
// Persist the cross-repo PR list's repos (partial update, other fields untouched).
async function savePrRepos(next: string[]): Promise<boolean> {
  const r = await postConfigField("prRepos", next);
  if (r.ok) prRepos.value = stringsOf(r.value);
  return r.ok;
}
// Persist the self-hosted GitLab hosts. The server drops anything that is not a bare hostname, so
// the echo is what lands here rather than what was sent — a rejected entry has to disappear from
// the list, not sit there looking saved.
async function saveGitlabHosts(next: string[]): Promise<boolean> {
  const r = await postConfigField("gitlabHosts", next);
  if (r.ok) gitlabHosts.value = stringsOf(r.value);
  return r.ok;
}

// The settings that are PUSHED into other modules rather than held as refs here. Grouped for the
// same reason as adoptSoundConfig: loadConfig should read as what the config decides, not as the
// plumbing for each decision.
function applyGlobalSettings(c: Record<string, unknown>): void {
  // The Enter-key submit/newline byte mapping, so every terminal's key handler honours it.
  // Unset falls back to the standard binding.
  setTerminalSubmitMode(isTerminalSubmitMode(c.terminalSubmit) ? c.terminalSubmit : DEFAULT_TERMINAL_SUBMIT_MODE);
  // Keyboard shortcuts are opt-in: no `keymap` in config.json leaves this empty and
  // every shortcut stays off.
  setActiveKeymap(c.keymap);
  // Copy-on-select, off unless config.json asks for it — it changes the clipboard with no
  // key pressed, so it must never arrive by default.
  setCopyOnSelect(c.copyOnSelect);
  // Whether a cell may comment on the issue it is working on (#979). Off unless opted in.
  setIssueWorkComments(c.issueWorkComments);
  // How far the cockpit roster clamps each line. Absent `cockpitLines` keeps 2/2/3.
  setCockpitLines(c.cockpitLines);
  // The terminal font stack. Terminals already open re-fit when this lands — a different face
  // means different cell metrics.
  setGlobalFontFamily(c.fontFamily);
  // The user's own colour schemes (#996). Re-applied after loading, because the selected id
  // may name one of these: until the config arrives it resolves to nothing, and the app is
  // painted with the default.
  setCustomThemes(c.themes);
  refreshTheme();
}

// The settings this browser only DISPLAYS — the server is what acts on each of them. They still
// have to be adopted, because Settings shows and writes them; before there were controls, nothing
// on this side had a reason to know their values.
function adoptServerSideSettings(c: Record<string, unknown>): void {
  setHeaderConfigSummary(c);
  setPrWorkdirFooter(c.prWorkdirFooter);
  setAppendSystemPrompt(c.appendSystemPrompt);
  setDecisionDigest(c.decisionDigest);
  setWorklogEnabled(c.worklogEnabled);
  setWorklogIntervalHours(c.worklogIntervalHours);
}

// The user's own lists, adopted together — grouped like the sound and repo fields above.
//
// Each is filtered by the SAME guard its own save path uses. They used to differ: a save
// validated, the load on every page open did not.
function adoptListConfig(c: Record<string, unknown>): void {
  launchers.value = listOf(c.launchers, isLauncher);
  customAgents.value = listOf(c.customAgents, isCustomAgent);
  quickCommands.value = listOf(c.quickCommands, isQuickCommand);
  toolbarLinks.value = listOf(c.toolbarLinks, isToolbarLink);
  userMcpServers.value = listOf(c.userMcpServers, isUserMcpServer);
}

// The repo fields, adopted together — like adoptSoundConfig, so loadConfig keeps reading as a list
// of facts rather than growing a ternary per field.
function adoptRepoConfig(c: Record<string, unknown>): void {
  prRepos.value = stringsOf(c.prRepos);
  gitlabHosts.value = stringsOf(c.gitlabHosts);
  repoDirs.value = isRecord(c.repoDirs) ? readRepoDirs(c.repoDirs) : {};
}

// Only string values survive: the map goes straight into a request naming a working directory.
const readRepoDirs = (raw: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  Object.entries(raw).forEach(([repo, dir]) => {
    if (typeof dir === "string") out[repo] = dir;
  });
  return out;
};

// Remember which clone a repo's work starts in. MERGED into what is already saved, never
// replacing it: this is called with one repo's answer, and a whole-map write would drop every
// other repo's choice.
async function saveRepoDir(repo: string, dir: string): Promise<boolean> {
  const r = await postConfigField("repoDirs", { ...repoDirs.value, [repo]: dir });
  if (r.ok) repoDirs.value = isRecord(r.value) ? readRepoDirs(r.value) : repoDirs.value;
  return r.ok;
}
// Persist the cell-launcher commands (partial update).
async function saveLaunchers(next: Launcher[]): Promise<boolean> {
  const r = await postConfigField("launchers", next);
  if (r.ok) launchers.value = Array.isArray(r.value) ? r.value.filter(isLauncher) : [];
  return r.ok;
}
// Persist which kinds of push to send (partial update).
async function savePushKinds(next: PushKind[]): Promise<boolean> {
  const r = await postConfigField("pushKinds", next);
  if (r.ok) pushKinds.value = Array.isArray(r.value) ? r.value.filter(isPushKind) : [];
  return r.ok;
}
// Persist which moments beep (partial update).
async function saveSoundKinds(next: NotifyKind[]): Promise<boolean> {
  const r = await postConfigField("soundKinds", next);
  if (r.ok) soundKinds.value = Array.isArray(r.value) ? r.value.filter(isNotifyKind) : [];
  return r.ok;
}
// Persist the per-kind sounds (partial update). The whole map goes each time — the server
// merges by FIELD, not by key, so sending one kind would drop the others.
async function saveSounds(next: SoundMap): Promise<boolean> {
  const r = await postConfigField("sounds", next);
  if (r.ok) sounds.value = isRecord(r.value) ? readSoundMap(r.value) : {};
  return r.ok;
}
// Persist the phone quick commands (partial update).
async function saveQuickCommands(next: QuickCommand[]): Promise<boolean> {
  const r = await postConfigField("quickCommands", next);
  if (r.ok) quickCommands.value = Array.isArray(r.value) ? r.value.filter(isQuickCommand) : [];
  return r.ok;
}
// Persist the user MCP servers (partial update).
async function saveUserMcpServers(next: UserMcpServer[]): Promise<boolean> {
  const r = await postConfigField("userMcpServers", next);
  if (r.ok) userMcpServers.value = Array.isArray(r.value) ? r.value.filter(isUserMcpServer) : [];
  return r.ok;
}

// The notification-sound settings, as one object: every part is a module-level singleton or
// saver already, and listing all six in the return below is what pushed useAppConfig past its
// line budget without saying anything a reader needed.
const soundSettings = { soundFile, soundKinds, sounds, saveSound, saveSoundKinds, saveSounds };

// Server config (default workspace dir, home, directory presets, custom sound)
// shared by both the single view and the grid view so each can open the settings
// modal without duplicating the fetch/save logic.
//
// CAUTION — only SOME of what this returns is shared state. The refs declared module-level
// above (sound, push, repos, launchers, quick commands, MCP) are singletons: any caller reads
// the same value. The four below are NOT — each useAppConfig() call gets its own, and they
// only ever fill in for the caller that also runs `loadConfig`. A component that reads
// `presets` here without loading gets a permanently empty list, which looks exactly like a
// user who has opened no directories. Take them from the shell that loaded them instead.
export function useAppConfig() {
  const defaultCwd = ref<string | null>(null);
  const presets = ref<CwdPreset[]>([]);
  const saving = ref(false);
  const error = ref<string | null>(null);

  const { savePresets, recordPreset, removePreset, migrateLegacyRecents, snapshotVersion, adoptServerPresets } = createPresetManager(presets, saving, error);

  async function loadConfig() {
    const version = snapshotVersion();
    try {
      const res = await fetchWithTimeout("/api/config");
      if (!res.ok) return;
      const body: unknown = await res.json();
      if (!isRecord(body)) return;
      const c = body;
      defaultCwd.value = typeof c.cwd === "string" ? c.cwd : null;
      home.value = typeof c.home === "string" ? c.home : null;
      adoptServerPresets(c.cwdPresets, version);
      adoptSoundConfig(c);
      pushEnabled.value = c.pushEnabled === true;
      pushKinds.value = listOf(c.pushKinds, isPushKind);
      adoptRepoConfig(c);
      adoptListConfig(c);
      applyGlobalSettings(c);
      adoptServerSideSettings(c);
      await migrateLegacyRecents();
    } catch {
      // the app still works; presets are just unavailable
    }
  }

  return {
    defaultCwd,
    home,
    presets,
    prRepos,
    gitlabHosts,
    saveGitlabHosts,
    repoDirs,
    saveRepoDir,
    launchers,
    customAgents,
    quickCommands,
    toolbarLinks,
    userMcpServers,
    ...soundSettings,
    pushEnabled,
    pushKinds,
    saving,
    error,
    loadConfig,
    savePresets,
    recordPreset,
    removePreset,
    savePushEnabled,
    savePushKinds,
    savePrRepos,
    saveLaunchers,
    saveQuickCommands,
    saveUserMcpServers,
  };
}
