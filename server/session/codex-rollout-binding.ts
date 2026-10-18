import { codexRolloutPath } from "../agents/codex-sessions.js";
import { readSessionMeta, watchForCodexSession, type RolloutMeta } from "../agents/codex-session.js";
import { liveCodexRollout } from "../agents/codex-live-rollout.js";
import { tmuxPanePidAsync } from "../infra/tmux.js";
import { mulmoterminalHome } from "../infra/mulmoterminal-home.js";
import { readLegacyCodexRolloutId } from "./codex-legacy-rollout.js";
import { watchCodexIdentity } from "./codex-identity-watch.js";
import { trackCodexActivity } from "./codex-activity-track.js";
import {
  aiTitles,
  lastPrompts,
  lastResponses,
  lastTitledUserTurns,
  lastTitleAttemptMs,
  titleEpoch,
  claimedCodexRollouts,
  codexRollouts,
  codexRolloutsHydrated,
  ptys,
  rememberCodexRollout,
} from "./registry.js";
import type { SpawnDeps } from "./spawn-deps.js";
import type { PtyEntry } from "./types.js";

/** A browser's resume argument is not evidence about an already running process. */
export function codexActivityRolloutId(resume: string | null, reattached: boolean, mapped: string | null): string | null {
  return reattached ? mapped : resume;
}

function forgetDisplay(id: string): void {
  aiTitles.delete(id);
  lastPrompts.delete(id);
  lastResponses.delete(id);
  lastTitledUserTurns.delete(id);
  lastTitleAttemptMs.delete(id);
  titleEpoch.set(id, (titleEpoch.get(id) ?? 0) + 1);
}

function existingRollout(root: string, id: string | null): RolloutMeta | null {
  const file = id ? codexRolloutPath(root, id) : null;
  const meta = file ? readSessionMeta(file) : null;
  return file && meta && meta.id === id ? { ...meta, file } : null;
}

interface Binding {
  id: string;
  entry: PtyEntry;
  root: string;
  before: Set<string>;
  reattached: boolean;
  resume: string | null;
}

export async function bindCodexRollout(binding: Binding, deps: SpawnDeps): Promise<void> {
  const { id, entry, root, before, reattached, resume } = binding;
  const isAlive = () => ptys.get(id) === entry;
  await codexRolloutsHydrated;
  if (!isAlive()) return;
  const mapped = codexRollouts.get(id)?.conversationId ?? null;
  const legacy = reattached ? readLegacyCodexRolloutId(mulmoterminalHome(), id) : null;
  const initial = existingRollout(root, codexActivityRolloutId(resume, reattached, mapped)) ?? (reattached ? existingRollout(root, legacy) : null);
  let trackedFile: string | null = null;
  let inspectedPid: number | null = null;
  const accept = (meta: RolloutMeta) => {
    if (!isAlive()) return;
    entry.codexRolloutBound = true;
    if (codexRollouts.get(id)?.conversationId !== meta.id) forgetDisplay(id);
    trackedFile = meta.file;
    claimedCodexRollouts.add(meta.file);
    rememberCodexRollout(id, meta.id, meta.cwd ?? entry.cwd);
    trackCodexActivity(id, meta.file, reattached || resume !== null, {
      setWorking: deps.setWorking,
      setWaiting: deps.setWaiting,
      uiPort: deps.uiPort,
      isActive: () => entry.active,
      isAlive: () => isAlive() && trackedFile === meta.file,
    });
    deps.publishActivity(id);
  };
  if (process.platform === "linux") {
    await watchCodexIdentity({
      isAlive,
      onChange: accept,
      readLive: async () => {
        const pid = entry.tmux ? await tmuxPanePidAsync(id) : entry.term.pid;
        if (pid !== inspectedPid) {
          entry.codexRolloutBound = false;
          inspectedPid = pid;
        }
        if (!pid) return null;
        const observed = liveCodexRollout(root, pid);
        if (entry.tmux && (await tmuxPanePidAsync(id)) !== pid) return null;
        return observed;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } else if (initial) accept(initial);
  else if (!reattached) {
    const meta = await watchForCodexSession(root, before, {
      cwd: entry.cwd,
      claimed: claimedCodexRollouts,
      isCancelled: () => !isAlive(),
      maxWaitMs: Number.POSITIVE_INFINITY,
    });
    if (meta) accept(meta);
  }
}
