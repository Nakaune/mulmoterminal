// What a spawnBackgroundChat request asks for. Split from the route (#548) because the
// two rules below are policy, not plumbing, and the route is otherwise just a uuid, a
// spawn and a response.
//
// The agent tool calls this, so the body is whatever a model produced — every field is
// treated as absent unless it is exactly what we accept.
import fsp from "node:fs/promises";
import path from "node:path";
import { asTerminalAgent, type TerminalAgent } from "../../common/sessionAgent.js";
import { isRecord } from "../../common/isRecord.js";

export interface BackgroundChatRequest {
  agent: TerminalAgent;
  /** Type the text into the input box for the user to review, instead of running it. */
  draft: boolean;
  /** Keep the session out of the sidebar. */
  hidden: boolean;
  message: string;
  /** Where the session starts. Absent = the server's default cwd. Not yet vetted: the route
   *  runs it through resolveSpawnCwd before it becomes a working directory. */
  cwd?: string | undefined;
}

/** The request, or the message to answer with when it cannot be served. */
export function parseBackgroundChat(body: unknown): { ok: true; request: BackgroundChatRequest } | { ok: false; message: string } {
  const record: Record<string, unknown> = isRecord(body) ? body : {};
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) return { ok: false, message: "spawnBackgroundChat: `message` is required (non-empty string)." };
  if (record.cwd !== undefined && (typeof record.cwd !== "string" || !path.isAbsolute(record.cwd) || record.cwd.includes("\0"))) {
    return { ok: false, message: "spawnBackgroundChat: `cwd` must be an absolute directory path." };
  }
  return {
    ok: true,
    request: {
      // Anything unrecognised is claude, the default — the same rule the UI's remembered
      // toggle reads by, so a model naming an agent we don't host gets a session rather
      // than an error about a field it half-guessed.
      agent: asTerminalAgent(record.agent),
      draft: record.draft === true,
      hidden: record.hidden === true,
      message,
      cwd: typeof record.cwd === "string" && path.isAbsolute(record.cwd) ? record.cwd : undefined,
    },
  };
}

const realpathOrNull = (p: string): Promise<string | null> => fsp.realpath(p).catch(() => null);

const isSameOrInside = (root: string, target: string): boolean => {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
};

/** Whether a requested working directory may be spawned in, or the message to answer with.
 *
 *  `cwd` arrives from an HTTP caller but becomes a session's working directory, so it is not taken
 *  on trust: it has to be an existing directory whose REAL path (symlinks resolved, so a link
 *  inside an allowed tree cannot lead out of it) is the default cwd, inside it, or one of the
 *  known clones, or inside one. Same stance as /api/issues/start, which only starts work in a
 *  clone the server resolved itself. On success it returns the canonical realpath so the
 *  spawner and the caller's receipt identify the same directory. */
export async function resolveSpawnCwd(cwd: string, allowedRoots: readonly string[]): Promise<{ ok: true; cwd: string } | { ok: false; message: string }> {
  const requested = path.resolve(cwd);
  const real = await realpathOrNull(requested);
  const isDir =
    real !== null &&
    (await fsp
      .stat(real)
      .then((s) => s.isDirectory())
      .catch(() => false));
  if (real === null || !isDir) return { ok: false, message: `spawnBackgroundChat: \`cwd\` ${cwd} is not an existing directory.` };
  const roots = (await Promise.all(allowedRoots.map(realpathOrNull))).filter((r): r is string => r !== null);
  if (!roots.some((root) => isSameOrInside(root, real))) {
    return {
      ok: false,
      message: `spawnBackgroundChat: \`cwd\` ${cwd} is neither inside the server's default directory nor inside a known clone, so no session was started.`,
    };
  }
  return { ok: true, cwd: real };
}

export type SpawnMode = "claude-draft" | "claude-run" | "codex-run" | "antigravity-run" | "grok-run";

/** How the seed reaches the agent. Only claude has an editable-draft path — the others have no
 *  stable TUI ready-marker to type against — so their seed always auto-runs, and asking for a
 *  draft there gets a run rather than nothing.
 *
 *  A Record over the agents, so hosting a new one fails to compile here rather than falling
 *  through to a claude spawn under its name. */
const RUN_MODE: Record<TerminalAgent, SpawnMode> = {
  claude: "claude-run",
  codex: "codex-run",
  antigravity: "antigravity-run",
  grok: "grok-run",
};

export function spawnModeFor(agent: TerminalAgent, draft: boolean): SpawnMode {
  return agent === "claude" && draft ? "claude-draft" : RUN_MODE[agent];
}

/** What the agent tool is told it did. The wording differs because the outcomes differ:
 *  a draft waits for the user, a run is already working. */
export function backgroundChatMessage(agent: TerminalAgent, draft: boolean, sessionId: string): string {
  if (agent !== "claude") return `Spawned a new ${agent} session (chatId ${sessionId}) auto-running the prompt.`;
  if (draft) return `Opened a new terminal session (chatId ${sessionId}) with the text prefilled in the input for the user to review and send.`;
  return `Spawned a new terminal session (chatId ${sessionId}). It runs in parallel; the user can open it from the sidebar.`;
}
