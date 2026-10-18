// Starting a codex session in a PTY. Unlike claude, codex mints its rollout id only after
// the first turn, so a fresh session is watched until that id appears — that is what lets
// a later cold reconnect resume it. Split from index.ts (#548 step 3c).
import type { WebSocket } from "ws";
import { PORT } from "../config/env.js";
import { buildCodexArgs } from "../agents/codex-args.js";
import { codexAdapter } from "../agents/codex.js";
import type { ToolGroup } from "../../common/toolGroups.js";
import { codexGuiMcpServers } from "./mcp-config.js";
import { codexSessionsRoot, snapshotSessions } from "../agents/codex-session.js";
import { claimFullGuiMcp, ptys } from "./registry.js";
import { ptySpawn, ptyWouldReattach } from "./pty-spawn.js";
import { ptyStartLine } from "./pty-exit-log.js";
import { wireAgentPtyRelay } from "./pty-relay.js";
import { attachCodexAutoRun } from "./draft-injection.js";
import type { PtyEntry } from "./types.js";
import type { SpawnDeps } from "./spawn-deps.js";
import { bindCodexRollout } from "./codex-rollout-binding.js";
import { createCodexTerminalActivityParser } from "../agents/codex-terminal-activity.js";
import { watchTmuxRawOutput } from "../infra/tmux.js";
export { codexActivityRolloutId } from "./codex-rollout-binding.js";

export function createCodexSpawner(deps: SpawnDeps) {
  function spawnCodexPty(
    sessionId: string,
    ws: WebSocket | null,
    resumeRolloutId: string | null,
    cwd: string,
    attachGuiMcp: boolean,
    // The two things only some callers have. An object rather than two more positional
    // arguments: seven of those is past the point where a call site can be read.
    options: {
      /** Typed into codex's input box once it settles, for a session started to run something. */
      initialPrompt?: string | null;
      /** The tool groups this cell's DIRECTORY has registered, for a grid cell (gui=0). Read by
       *  the caller because the lookup reads Claude Code's config files, and this is sync. */
      mcpGroups?: readonly ToolGroup[];
    } = {},
  ): PtyEntry {
    const { initialPrompt = null, mcpGroups = [] } = options;
    const root = codexSessionsRoot();
    const before = snapshotSessions(root);
    // Two surfaces, the same two claude has:
    //   single view (gui) — the whole GUI MCP on one per-session URL.
    //   grid cell (gui=0) — one URL per tool group the DIRECTORY registered, which the caller
    //     read from the same config claude's own switches write (see the launcher's Canvas
    //     rows). codex cannot read that config itself, so the groups arrive resolved here.
    // A grid cell whose directory registered nothing gets no MCP at all, exactly as before.
    //
    // The workspace-cwd rule APPLIES here, and it did not use to. It was withheld on the grounds
    // that it exists to make a workspace cell equivalent to the single view, and the single view
    // only ever ran claude — so extending it to codex was a new capability rather than a migrated
    // one. The owner's call (2026-08-03) is that the workspace cell is agent-agnostic: two cells in
    // the same directory differing only by which agent runs in them should not differ in what the
    // agent can reach. So a codex session in the workspace gets the whole GUI MCP, as claude's does.
    //
    // It is a real widening, because codex approves per SERVER: everything on that URL is waved
    // through at once — the external accounts (google, X), the paid generation, and
    // spawnBackgroundChat, which belongs to no group and is therefore reachable ONLY this way. All
    // of it was already auto-allowed for claude in the same cell, which is the asymmetry this
    // closes; it is still the widest thing this flag does, and the reason it is spelled out here.
    // The claim is RELEASED here as well as made — a codex session resumed into a project directory
    // reuses the id, and a stale claim would stand its group urls down with nothing left to serve
    // them (Codex review on #1399). claimFullGuiMcp owns both directions so neither spawn path can
    // apply half the rule.
    const allTools = claimFullGuiMcp(sessionId, attachGuiMcp, cwd, ptyWouldReattach(sessionId, true), "codex");
    const guiMcpServers = codexGuiMcpServers({ sessionId, port: PORT, groups: mcpGroups, allTools });
    const args = buildCodexArgs({ resume: resumeRolloutId, model: deps.codexModel, guiMcpServers });
    const { term, tmux, reattached } = ptySpawn(sessionId, deps.codexBin, args, cwd, true, { binEnvVar: codexAdapter.binEnvVar });
    const spawnedAtMs = Date.now();
    const note = resumeRolloutId ? `resume ${resumeRolloutId}` : null;
    console.log(ptyStartLine({ agent: "codex", pid: term.pid, cwd, tmux, reattached, sessionId, note }));
    const entry: PtyEntry = { term, ws, buffer: "", cwd, tmux, active: false, agent: "codex" };
    ptys.set(sessionId, entry);
    void bindCodexRollout({ id: sessionId, entry, root, before, reattached, resume: resumeRolloutId }, deps).catch((error: unknown) =>
      console.error("[codex-identity] failed to bind", sessionId, error),
    );
    // A seed prompt is typed into codex's input box after it settles (not a CLI arg — see
    // attachCodexAutoRun), so a long collection-action prompt can't overflow tmux's command limit.
    const autoRun = initialPrompt ? attachCodexAutoRun(entry, initialPrompt) : undefined;
    const parseTerminalActivity = createCodexTerminalActivityParser((state) => {
      if (state === null) {
        delete entry.codexTerminalState;
      } else if (state === "working") {
        if (entry.codexTerminalState === "working") return;
        entry.codexTerminalState = "working";
        deps.setWorking(sessionId, true, "UserPromptSubmit");
        deps.setWaiting(sessionId, false);
      } else {
        const wasWorking = entry.codexTerminalState === "working";
        entry.codexTerminalState = "idle";
        deps.setWorking(sessionId, false, wasWorking ? "Stop" : undefined);
        if (wasWorking) {
          deps.setWaiting(sessionId, !entry.active);
        }
      }
    });
    if (entry.tmux) {
      const stopRawOutput = watchTmuxRawOutput(sessionId, (data) => {
        if (ptys.get(sessionId) === entry) parseTerminalActivity(data);
      });
      entry.term.onExit(stopRawOutput);
    }
    wireAgentPtyRelay(entry, sessionId, spawnedAtMs, deps, (data) => {
      if (!entry.tmux) parseTerminalActivity(data);
      autoRun?.(data);
    });
    return entry;
  }

  return { spawnCodexPty };
}
