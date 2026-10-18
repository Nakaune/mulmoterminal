// The hidden Claude session that harvests the rate-limit windows (#387).
//
// It exists because the windows are only ever handed to a `statusLine` command, and only by an
// INTERACTIVE session that has had at least one API response — both measured. So the probe is a
// real `claude` PTY that is asked one trivial question, reports through the statusLine, and is
// killed. Nobody ever sees its terminal, which is what makes this cheaper than #388's design: that
// one injected the statusLine into the user's own cells and cost each of them a row.
//
// What it costs instead is one small query against the very budget it reports. That is the whole
// reason the caller only asks when a browser is watching (see rate-limit-store.ts) — a probe on a
// timer would spend the user's window overnight to refresh a number nobody is reading.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { statusLineCommand } from "./statusline.js";
import { appendProbeScreen, classifyProbeStall, type ProbeStall } from "./probe-stall.js";

// Long enough for a cold `claude` to boot, answer, and re-render its status line; short enough
// that a probe which will never report (no binary, an unaccepted trust prompt, an expired login)
// gives up rather than holding a PTY open.
export const PROBE_TIMEOUT_MS = 90_000;

// The question. Anything answerable without tools, because the point is to cause ONE API response
// — the cheapest thing that makes `rate_limits` appear.
//
// Exported because it is also the only thing that identifies a transcript written by a probe that
// predates `--session-id` (#1010). Change it and those become unrecognisable — which is a reason
// to leave it alone, not a reason to keep the two copies in sync.
export const PROBE_PROMPT = "reply with the single character: .";

export interface ProbePty {
  kill(): void;
  /** The probe's own output. Read only to explain a failure — see probe-stall.ts. */
  onData(listener: (chunk: string) => void): void;
  /** Keys for the TUI. Used ONLY once the status line has reported (see `reported` below): before
   *  that the TUI may still be booting, and keys typed at a TUI that is not listening are
   *  discarded or, worse, confirm whatever dialog is up (#1293). */
  write(data: string): void;
}

// The per-model weekly windows ("Current week (Fable)") are not in the status line
// (claude-usage-cache.ts) — they are written to `~/.claude.json` by claude's own `/usage`. So once
// the probe's question has been answered, which proves the TUI is taking input, it opens `/usage`
// and waits for that file to change. The slash menu needs a moment to filter before Enter picks
// the command; the fetch itself landed within a second when measured (2.1.285, 2026-10-01).
export const USAGE_COMMAND = "/usage";
export const USAGE_MENU_DELAY_MS = 600;
export const USAGE_POLL_MS = 500;
// Longer than the fetch needs, shorter than PROBE_TIMEOUT_MS: a probe whose `/usage` never lands
// (an older claude, a dialog that did not open) still ends in seconds, not in a minute and a half.
export const USAGE_WAIT_MS = 15_000;

/** A running probe. `stop` is the timeout's and the caller's way out; `reported` is for the moment
 *  the status line has delivered the windows, after which the probe collects `/usage` and stops
 *  itself. */
export interface ProbeHandle {
  stop(): void;
  reported(): void;
}

/** How a probe ended: what its terminal proved, and the terminal itself for the cases where it
 *  proved nothing. Handed to `onSettled` whether or not the probe succeeded — the store owns the
 *  question of whether anything reported, and this owns the question of what was on screen. */
export interface ProbeOutcome {
  stall: ProbeStall;
  screen: string;
}

export interface ProbeDeps {
  // Injected so a test can drive the lifecycle without a real terminal.
  spawn: (args: string[], cwd: string) => ProbePty;
  host: string;
  port: string | number;
  cwd: string;
  sessionId: string;
  onSettled: (outcome: ProbeOutcome) => void;
  /** When claude last wrote its usage cache, or null. Polled after `/usage` is sent: a change is
   *  what says the per-model windows have landed and the terminal can go. */
  usageCacheFetchedAt_ms: () => number | null;
}

/**
 * Start one probe. Returns its handle: `stop` for the timeout, `reported` for the report arriving.
 *
 * Failure has no branch of its own HERE on purpose: a trust prompt nobody answered, a login that
 * expired, a machine too slow to boot the TUI — all of them look the same from inside one probe
 * (no report before the timeout), and all of them want the same response, which is to stop and
 * leave the gauge showing what it had.
 *
 * Telling them apart is the CALLER's job, and it matters: `claude` missing is decided before this
 * runs (a PATH lookup, not a spawn), and "a status line arrived carrying no windows" is decided by
 * the report route. Both used to arrive here as the same silence, which is how a failing probe
 * re-fired every 90 seconds forever (#1011).
 *
 * What this DOES carry out is the screen: the terminal is the only place a stalled probe leaves any
 * evidence at all, so `onSettled` gets what was on it (#1293).
 */
export function startRateLimitProbe(deps: ProbeDeps): ProbeHandle {
  // Setup is inside the guard, not before it. It reaches the disk — a full or read-only tmp throws
  // — and the caller has ALREADY marked a probe in flight by the time this runs. An escape here
  // would leave that flag set with nothing to clear it, so the gauge would stop refreshing for the
  // life of the process. Every failure has to arrive as "this probe reported nothing".
  let settings: { dir: string; file: string };
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-ratelimit-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: statusLineCommand(deps.host, deps.port) } }), {
      mode: 0o600,
    });
    settings = { dir, file };
  } catch {
    deps.onSettled({ stall: "unknown", screen: "" });
    return { stop: () => {}, reported: () => {} };
  }
  const { dir, file: settingsFile } = settings;

  let stopped = false;
  let pty: ProbePty | null = null;
  let screen = "";
  const usage = newUsageWatch();
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearUsageWatch(usage);
    try {
      pty?.kill();
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
    deps.onSettled({ stall: classifyProbeStall(screen), screen });
  };
  const timer = setTimeout(stop, PROBE_TIMEOUT_MS);

  try {
    // `--session-id` so the transcript claude writes has an id WE chose. Without it claude mints
    // its own, and a session nobody asked for lands in /api/sessions and `claude --resume` with
    // nothing to identify it by (#1010). The caller registers the same id as an internal helper,
    // which is what keeps it out of the listing.
    pty = deps.spawn(probeArgs(deps.sessionId, settingsFile), deps.cwd);
    pty.onData((chunk) => {
      screen = appendProbeScreen(screen, chunk);
    });
  } catch {
    // `claude` is not installed, or cannot be launched at all. Same outcome as any other failure.
    stop();
  }
  // The windows are in: the TUI has answered, so it is listening. Idempotent, because the status
  // line can fire more than once with the windows in it.
  const reported = (): void => {
    if (stopped || usage.requested || pty === null) return;
    openUsage(pty, deps, stop, usage);
  };
  return { stop, reported };
}

/** The timers behind one probe's `/usage` request, so stop() can clear whatever is pending. */
interface UsageWatch {
  requested: boolean;
  timers: ReturnType<typeof setTimeout>[];
  poll: ReturnType<typeof setInterval> | null;
}
const newUsageWatch = (): UsageWatch => ({ requested: false, timers: [], poll: null });
function clearUsageWatch(watch: UsageWatch): void {
  for (const t of watch.timers) clearTimeout(t);
  if (watch.poll !== null) clearInterval(watch.poll);
}

/** Ask the TUI for `/usage` and leave as soon as claude has written its cache — or after
 *  USAGE_WAIT_MS if it never does. A terminal that is already gone makes write() throw; the
 *  windows the status line delivered stand, so that just ends the probe. */
function openUsage(pty: ProbePty, deps: Pick<ProbeDeps, "usageCacheFetchedAt_ms">, stop: () => void, watch: UsageWatch): void {
  watch.requested = true;
  const before = deps.usageCacheFetchedAt_ms();
  const type = (keys: string): void => {
    try {
      pty.write(keys);
    } catch {
      stop();
    }
  };
  type(USAGE_COMMAND);
  watch.timers.push(setTimeout(() => type("\r"), USAGE_MENU_DELAY_MS));
  watch.timers.push(setTimeout(stop, USAGE_WAIT_MS));
  watch.poll = setInterval(() => {
    const now = deps.usageCacheFetchedAt_ms();
    if (now !== null && now !== before) stop();
  }, USAGE_POLL_MS);
}

/**
 * How the probe asks its question: as claude's own positional prompt, so the session submits it
 * itself and nothing is ever typed at the terminal.
 *
 * It used to be typed — the prompt written 4 seconds after the spawn and a submit 800ms after that
 * — and the fixed wait is what made the gauge unfixable in some setups (#1293). A TUI that is not
 * accepting input yet DISCARDS the keystrokes: measured on a real pty, typing early leaves
 * `❯ replywiththesinglecharacter:.` in the box (the spaces swallowed too) with the Enter lost, so
 * nothing is ever asked, no API response happens, and the probe can only time out — then back off,
 * retry on the same fixed timings, and fail identically. Anything that slows a claude start past
 * that window (MCP connectors negotiating OAuth, plugin sync, a slow disk) makes the usage readout
 * permanently unavailable with nothing on screen to say why.
 *
 * Sending no keys also means the probe can no longer ANSWER anything: a blind Enter confirms the
 * default choice of whatever dialog is up, and in an untrusted directory that is "Yes, I trust this
 * folder" — verified writing `hasTrustDialogAccepted` for a directory nobody approved.
 *
 * `--strict-mcp-config` for the same reason as the prompt: the probe asks one question that needs
 * no tools, so loading the user's MCP servers (account connectors, plugins, `.mcp.json`) buys
 * nothing and costs startup time — measured at 8.0s to first windows without them and 9-15s with a
 * single unauthenticated one. It affects this hidden session only; the user's own sessions keep
 * every server they have configured.
 */
export const probeArgs = (sessionId: string, settingsFile: string): string[] => [
  "--session-id",
  sessionId,
  "--permission-mode",
  "auto",
  "--strict-mcp-config",
  "--settings",
  settingsFile,
  PROBE_PROMPT,
];
