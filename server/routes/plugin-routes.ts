// The three GUI-plugin tool routes this server answers itself, rather than through a plugin
// package's own router.
//
// All three MUST be mounted before mountAllRoutes' /api/plugin/:toolName catch-all, which
// would otherwise take them. Their failure reporting is narration by contract — see
// plugin-narration.ts for why a failed tool call must still be a 200.
import { randomUUID } from "node:crypto";
import type { Express } from "express";

import { CLAUDE_CWD, PORT } from "../config/env.js";
import { messageOf } from "../errors.js";
import { isRecord } from "../../common/isRecord.js";
import { backgroundMarkers, markFailedWorker, markUnplacedSession } from "../session/registry.js";
import { runWithHiddenMarker } from "../session/hiddenMarker.js";
import { registerCompletionHook } from "../session/completion-hooks.js";
import { backgroundChatMessage, parseBackgroundChat, resolveSpawnCwd, spawnModeFor, type SpawnMode } from "../session/background-chat.js";
import { registeredGuiMcpGroups } from "../infra/gui-mcp-registration.js";
import { TOOL_GROUPS, type ToolGroup } from "../../common/toolGroups.js";
import { codexifySkillSeed } from "../agents/codex-skills.js";
import { manageCollectionHandler } from "../infra/collection-tool.js";
import { getCwdPresets, getRepoDirs } from "../config/config-routes.js";
import { repoDirsFromPresets } from "../git/repo-dirs.js";
import { upstreamFailureMessage } from "./plugin-narration.js";
import type { SpawnClaudePty, SpawnCodexPty, SpawnAntigravityPty, SpawnGrokPty } from "../session/spawners.js";

export interface PluginRouteDeps {
  spawnClaudePty: SpawnClaudePty;
  spawnCodexPty: SpawnCodexPty;
  spawnAntigravityPty: SpawnAntigravityPty;
  spawnGrokPty: SpawnGrokPty;
  /** Put a hidden spawn on the scheduled-session retention (#541). Nobody watches a
   *  background worker and the chat list keeps it behind a filter, so the hook-driven reap
   *  is the only thing that would ever end it — and a worker blocked on a permission prompt
   *  never fires the hook that starts it. */
  registerBackgroundSession: (id: string) => void;
}

// Which agent to start, and how the seed reaches it — one switch over SpawnMode, so an agent added
// to TERMINAL_AGENTS reaches this as a mode with no case rather than as a silent claude spawn.
//
// ws is null on every branch: the session runs headless until the user opens it (a reattach replays
// the buffered output). A claude DRAFT spawns with no initial prompt, so it does not auto-run, and
// the text is typed into its input box afterwards; the other agents have no editable-draft path (no
// stable TUI ready-marker), so their seed always auto-runs as a first-turn prompt — codex typed in,
// agy through `--prompt-interactive`, grok as a positional.
function spawnSeededSession(
  deps: PluginRouteDeps,
  mode: SpawnMode,
  { sessionId, message, mcpGroups, cwd }: { sessionId: string; message: string; mcpGroups: readonly ToolGroup[]; cwd: string },
): void {
  const initialPrompt = codexifySkillSeed(message);
  if (mode === "codex-run") deps.spawnCodexPty(sessionId, null, null, cwd, true, { initialPrompt });
  else if (mode === "antigravity-run") deps.spawnAntigravityPty(sessionId, null, null, cwd, { mcpGroups, initialPrompt });
  else if (mode === "grok-run") deps.spawnGrokPty(sessionId, null, null, cwd, { mcpGroups, initialPrompt });
  else if (mode === "claude-draft") deps.spawnClaudePty(sessionId, null, null, { draft: message, cwd });
  else deps.spawnClaudePty(sessionId, null, null, { initialPrompt: message, cwd });
}

// An absent cwd is the server's default, as before. A given one is checked against the default
// directory and the known clones (resolveSpawnCwd), and a refusal is narrated like any other.
async function spawnCwdFor(requested: string | undefined): ReturnType<typeof resolveSpawnCwd> {
  if (requested === undefined) return { ok: true, cwd: CLAUDE_CWD };
  const clones = (await repoDirsFromPresets(getCwdPresets(), getRepoDirs()).catch(() => [])).flatMap((r) => r.dirs.map((d) => d.path));
  return resolveSpawnCwd(requested, [CLAUDE_CWD, ...clones]);
}

export function mountPluginRoutes(app: Express, deps: PluginRouteDeps): void {
  // Host tool: spawnBackgroundChat. Unlike a plugin (handled by mountAllRoutes'
  // catch-all), it needs server internals — it spawns a brand-new interactive Claude
  // terminal session, seeded with `message`, that the user can open from the sidebar.
  // `role` is ignored (MulmoTerminal has no roles). `hidden:true` marks it a background
  // worker: it still lists in the sidebar, but behind the Background filter and never
  // bold/unread. `draft:true` makes `message` an editable DRAFT — typed into the input box
  // but NOT auto-submitted (the collection-plugin's startNewChatDraft / template cards),
  // so the user reviews and presses Enter.
  app.post("/api/plugin/spawnBackgroundChat", async (req, res) => {
    const parsed = parseBackgroundChat(req.body);
    if (!parsed.ok) return res.json({ message: parsed.message });
    const { agent, draft, hidden, message } = parsed.request;
    const where = await spawnCwdFor(parsed.request.cwd);
    if (!where.ok) return res.json({ message: where.message });
    const { cwd } = where;
    const sessionId = randomUUID();
    // The agents that read their GUI MCP servers from a FILE in the working directory — agy's
    // `.agents/mcp_config.json` and grok's `.grok/config.toml` — share that file with every other
    // session running there, so the groups have to be resolved BEFORE the spawn rewrites it:
    // passing none would clear the entries those sessions are using (#1095 review).
    const fileConfigAgent = agent === "antigravity" || agent === "grok";
    const mcpGroups = fileConfigAgent ? await registeredGuiMcpGroups(cwd, TOOL_GROUPS).catch(() => []) : [];
    try {
      runWithHiddenMarker(hidden, sessionId, backgroundMarkers, () =>
        spawnSeededSession(deps, spawnModeFor(agent, draft), { sessionId, message, mcpGroups, cwd }),
      );
      // Visible: somebody should be able to SEE this session. The browser that asked for it
      // places it immediately (useChatLauncher), and this covers every other caller — an agent
      // calling the tool from another session, with no tab open at all. The mark is cleared the
      // moment any cell attaches, so the browser-placed case does not come back as a duplicate.
      if (!hidden) markUnplacedSession(sessionId, agent);
      if (hidden) {
        deps.registerBackgroundSession(sessionId);
        // A hidden worker is invisible on purpose, which is exactly why a FAILED one needs a
        // record: nothing pulls the user's attention and nothing waits to be clicked, so the
        // failure is otherwise never learned. The completion hook is the existing seam for it —
        // a finished turn reports success first and this never fires; reaching teardown with no
        // Stop means no turn ever completed (see completion-hooks.ts for why first-answer-wins).
        //
        // Registered AFTER the spawn: a launch that threw has no session to report on, and would
        // leave a hook nothing will ever fire or clear. Safe against the feeds engine's own hook
        // (last writer wins) because that dispatches through its own spawner, never this route.
        //
        // CLAUDE ONLY, and that is a correctness limit rather than a scope choice. The single
        // success signal a PTY-hosted agent gives us is a finished turn reported by Claude Code's
        // Stop hook (hook-routes.ts); codex and antigravity have no hook mechanism at all, so
        // they can never report success. Registering for them would mean every SUCCESSFUL hidden
        // codex worker reached reap unreported and was marked failed — a signal that is wrong
        // more often than it is right, which is worse than the silence it replaced.
        // (Codex, PR #1188.) A non-claude hidden worker therefore keeps today's behaviour: no
        // failure signal. Giving it one needs a completion signal for those agents first.
        //
        // RECORDS ONLY, and synchronously. Announcing is reap's job: it publishes one teardown
        // message carrying this outcome, which is what keeps the generic notification from
        // racing ahead of the specific one. Staying synchronous is therefore a contract, not an
        // implementation detail — reap reads the flag immediately after firing this.
        if (agent === "claude") {
          registerCompletionHook(sessionId, ({ didError }) => {
            if (didError) markFailedWorker(sessionId);
          });
        }
      }
    } catch (err) {
      console.error(`[spawnBackgroundChat] failed for ${sessionId}: ${messageOf(err)}`);
      return res.json({ message: `Failed to spawn a new session: ${messageOf(err)}` });
    }
    return res.json({ message: backgroundChatMessage(agent, draft, sessionId), jsonData: { chatId: sessionId, agent } });
  });

  // Host tool: manageAccounting. The accounting package exposes no gui-chat-protocol
  // `.` core (just the Vue View + the /api/accounting router), so — like MulmoClaude's
  // host-side passthrough execute — this route bridges the GUI MCP tool to that router.
  // The router's envelope ({ action, ...data, message }) flows straight back to the
  // broker: `data` (set for PREVIEW actions) gates the GUI publish, `message` narrates
  // to claude.
  app.post("/api/plugin/manageAccounting", async (req, res) => {
    try {
      const upstream = await fetch(`http://127.0.0.1:${PORT}/api/accounting`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isRecord(req.body) ? req.body : {}),
      });
      const body: unknown = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        // A refused request is only ever narrated to the agent, so without this it leaves no
        // trace on the server at all — and a router answering `{ error: "" }` leaves none with
        // the agent either. "Could not connect" is logged below; "connected and was refused"
        // should be too.
        const message = upstreamFailureMessage(upstream.status, body, "accounting request failed");
        console.error(`[manageAccounting] upstream ${upstream.status}: ${message || "(no message)"}`);
        return res.json({ message });
      }
      return res.json(body);
    } catch (err) {
      console.error(`[manageAccounting] dispatch failed: ${messageOf(err)}`);
      return res.json({ message: `accounting dispatch failed: ${messageOf(err)}` });
    }
  });

  // Host tool: manageCollection — the shared collection data plane
  // (@mulmoclaude/core/collection/server, bound in server/infra/collection-tool.ts).
  // The engine runs in-process against the configured workspace, so the route calls the
  // handler directly. The result string (JSON for the read/write actions) narrates to claude
  // via the envelope `message`; no `data`, so nothing publishes to the GUI — same as
  // MulmoClaude.
  app.post("/api/plugin/manageCollection", async (req, res) => {
    try {
      const message = await manageCollectionHandler(isRecord(req.body) ? req.body : {});
      return res.json({ message });
    } catch (err) {
      console.error(`[manageCollection] dispatch failed: ${messageOf(err)}`);
      return res.json({ message: `manageCollection failed: ${messageOf(err)}` });
    }
  });
}
