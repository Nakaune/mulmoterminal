// The pull requests a CODEX session acted on, read out of the shell it ran.
//
// Claude Code hands the answer over: `gitOperation.pr` rides on the Bash tool result, so
// sessionPr.ts never parses a command line and never mistakes a read for a change. Codex has no
// equivalent — its rollout records the command and the text that came back and nothing else — so
// this has to read both, and the property that must survive the difference is exactly the one
// sessionPr.ts gets for free:
//
//   A READ IS NOT A CHANGE. `gh pr list --json url` prints twenty urls. Recording those would fill
//   the chip with requests the session never touched, which is worse than an empty chip: the chip
//   exists to answer "what did THIS session do".
//
// So a call is considered only when the commands it ran contain a write verb and no read verb. A
// batch that mixes them is skipped rather than guessed at — one Codex `exec` call can run several
// commands (`Promise.all([...])`), and the output arrives as one blob with no way to tell which
// command each line came from.
import { repoFromPrUrl, type SessionPr } from "./sessionPr.js";

// Verbs that CHANGE a request. `create` is called out below because it is the only one whose
// request did not exist before the command ran.
const WRITE_VERBS = new Set(["create", "edit", "merge", "ready", "close", "reopen", "comment", "review", "lock", "unlock"]);
// Verbs that only LOOK. Their output is full of urls that belong to other people's work.
const READ_VERBS = new Set(["view", "list", "status", "checks", "diff"]);

// `tools.exec_command({cmd: "…", …})` inside the JS snippet Codex stores as the call's input.
// Matched rather than parsed: the input is a program, not data, and the only part of it with a
// stable shape is this argument.
//
// The key is accepted BARE as well as quoted, because Codex writes both — a JS object literal
// (`cmd: "…"`) in the calls measured on 2026-08-28, and a JSON-shaped one elsewhere. Requiring the
// quoted form found nothing at all against real rollouts, silently.
const CMD_IN_INPUT = /(?:"cmd"|\bcmd)\s*:\s*"((?:[^"\\]|\\.)*)"/gu;
// `gh pr <verb>` anywhere in a command, so a chain (`git push && gh pr create …`) still answers.
const GH_PR_VERB = /\bgh\b[^\n;&|]*?\bpr\b\s+([a-z-]+)/gu;
// A request url in the output. GitHub and GitLab both put the project path in front of the marker.
const PR_URL = /https:\/\/[^\s"'`<>)\\]+?\/(?:pull|-\/merge_requests)\/(\d+)/u;

/** The shell commands one `exec` call ran. Empty when the input names none. */
export function execCommandsIn(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const found: string[] = [];
  for (const m of input.matchAll(CMD_IN_INPUT)) {
    const raw = m[1];
    if (raw === undefined) continue;
    try {
      // Back through JSON so `\"`, `\n` and friends are the characters the shell actually saw.
      const parsed: unknown = JSON.parse(`"${raw}"`);
      if (typeof parsed === "string") found.push(parsed);
    } catch {
      // A snippet that builds its command at runtime is not readable here; skipping it costs this
      // one call, never the scan.
    }
  }
  return found;
}

/** What `gh pr` verbs a set of commands used, split by whether they change anything. */
export function ghPrVerbs(commands: readonly string[]): { writes: string[]; reads: string[] } {
  const writes: string[] = [];
  const reads: string[] = [];
  for (const cmd of commands) {
    for (const m of cmd.matchAll(GH_PR_VERB)) {
      const verb = m[1];
      if (verb === undefined) continue;
      if (WRITE_VERBS.has(verb)) writes.push(verb);
      else if (READ_VERBS.has(verb)) reads.push(verb);
    }
  }
  return { writes, reads };
}

/**
 * The request one `exec` call acted on, or null.
 *
 * Null is the common answer and the safe one: most calls are not about a request at all, and the
 * ones that only looked at requests must answer null too (see the note at the top).
 *
 * The url comes from the OUTPUT rather than the command line because that is where it exists for
 * the case that matters most — `gh pr create` prints the url of a request whose number nothing
 * knew a moment earlier. For the other verbs gh prints it too, and taking the first is safe here
 * precisely because a call carrying a read verb never reaches this point.
 */
export function codexPrFromExec(input: unknown, output: string, at: number): SessionPr | null {
  const { writes, reads } = ghPrVerbs(execCommandsIn(input));
  if (writes.length === 0 || reads.length > 0) return null;
  const m = PR_URL.exec(output);
  if (!m) return null;
  const url = m[0];
  const number = Number(m[1]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, url, repo: repoFromPrUrl(url), created: writes.includes("create"), at };
}
