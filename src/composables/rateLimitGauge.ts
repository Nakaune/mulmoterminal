// What the header actually shows, decided away from the component so the rules are testable
// without mounting anything (#387).
//
// The one rule that outranks the rest: a window we do not have is NOT zero. The percentage is a
// budget already spent, so rendering 0% for missing data tells the reader they have everything
// left at the exact moment we cannot see how much they have — and upstream has dropped the field
// before (anthropics/claude-code#40094). Missing renders nothing at all.

import type { RateLimits, RateLimitWindow } from "../../common/rateLimits";

export interface RateLimitSnapshot {
  claude: RateLimits | null;
  codex: RateLimits | null;
  /** Why the Claude half is missing, when it is (#1011). The server's own words, so the two
   *  cannot describe the same situation differently. */
  claudeProbe?: ClaudeProbeState | undefined;
  /** Which silence, when the state is `no-report` (#1293). */
  claudeStall?: ClaudeProbeStall | undefined;
}

export type ClaudeProbeState = "ok" | "no-claude" | "no-windows" | "no-report";

/** The one silence the probe's screen can name. Everything else is `unknown`, which reads as the
 *  general no-report line — a wrong reason costs more than a vague one. */
export type ClaudeProbeStall = "trust-prompt" | "unknown";

// What to put where the Claude figures would be. Silence is right for "we simply have not
// measured yet", and wrong for the two states that will not resolve on their own: #1011 was a
// probe loop nobody could see, burning the budget the gauge exists to report.
const PROBE_NOTES: Record<ClaudeProbeState, string | null> = {
  ok: null,
  "no-claude": "Claude usage unavailable — the `claude` command was not found on PATH.",
  "no-windows": "Claude usage unavailable — this account reports no 5h / 7d windows (API-key billing).",
  "no-report": "Claude usage unavailable — the last check got no answer. Retrying, less often each time.",
};

// A trust prompt is the one stall a user can clear in ten seconds, and the only reason they would
// ever know to: the hidden session waits on a dialog they cannot see. It says "the folder" rather
// than naming one because the path is the server's (CLAUDE_CWD) and does not cross to the browser.
const TRUST_PROMPT_NOTE = "Claude usage unavailable — the usage check is waiting on Claude Code's trust prompt. Run `claude` in its folder once and accept it.";

/** A short line explaining an absent Claude gauge, or null when there is nothing worth saying —
 *  either it is showing, or it has simply not been measured yet.
 *
 *  Keyed on whether anything is actually DRAWN, not on whether a reading is held: a reading whose
 *  window has already reset is held but not drawn, and that is exactly when the reader most needs
 *  the reason. Checking `snapshot.claude` instead let a stale cached figure suppress the note —
 *  uninstall `claude` and the gauge would go on showing yesterday's percentage, silently. */
function claudeProbeNote(snapshot: RateLimitSnapshot | null, now_ms: number): string | null {
  if (!snapshot || gaugeWindows(snapshot.claude, now_ms).length > 0) return null;
  if (snapshot.claudeProbe === "no-report" && snapshot.claudeStall === "trust-prompt") return TRUST_PROMPT_NOTE;
  return PROBE_NOTES[snapshot.claudeProbe ?? "ok"];
}

export interface GaugeWindow {
  label: string;
  percent: number;
  /** Past this, the window is close enough to matter more than the other readings around it. */
  warn: boolean;
}

// Where "you should look at this" begins. Under it the number is information; over it, it is the
// thing that will stop the work.
export const WARN_PERCENT = 75;

const MS_PER_SEC = 1000;
const SEC_PER_MIN = 60;
const MIN_PER_HOUR = 60;

// A window whose reset time has PASSED says nothing about now: the budget it describes has already
// rolled over, so the percentage belongs to a window that no longer exists. Dropping it is the same
// rule as the one at the top of this file — a figure we cannot vouch for is worse than no figure,
// and "83% used" from before a reset reads exactly like 83% used today. `resetsAt` unknown means we
// cannot prove it is stale, so it stays.
const expired = (window: RateLimitWindow, now_ms: number): boolean => window.resetsAt_sec !== null && window.resetsAt_sec * MS_PER_SEC <= now_ms;

/** The windows worth saying anything about, in reading order.
 *
 *  ONE list, feeding both the figures and the hover / aria text. Deciding twice is how the two came
 *  apart: filtering only the rendered rows left the spoken label announcing a percentage the screen
 *  had deliberately dropped (Codex review on #1047). */
const liveWindows = (limits: RateLimits | null, now_ms: number): { label: string; window: RateLimitWindow }[] => {
  if (!limits) return [];
  // The account's own windows first, then the per-model ones, because that is the order the
  // question is asked in: how much of my week is gone, and then which model spent it. The scoped
  // labels are the server's own words (`fable`), so nothing here has a list of models to keep up
  // to date.
  const labelled = [
    { label: "5h", window: limits.fiveHour },
    { label: "7d", window: limits.sevenDay },
    ...(limits.scoped ?? []).map((window) => ({ label: window.label, window })),
  ];
  return labelled.flatMap(({ label, window }) => (window !== null && !expired(window, now_ms) ? [{ label, window }] : []));
};

/** The windows to render for one agent, in the order they are shown. Empty when the agent has
 * reported nothing — which covers "not installed", "API-key billing", "no session yet" and a
 * reading that has outlived its window alike, because there is nothing worth saying differently
 * about any of them. */
export function gaugeWindows(limits: RateLimits | null, now_ms: number): GaugeWindow[] {
  return liveWindows(limits, now_ms).map(({ label, window }) => ({
    label,
    percent: Math.round(window.usedPercentage),
    warn: window.usedPercentage >= WARN_PERCENT,
  }));
}

export interface AgentGauge {
  agent: "claude" | "codex";
  /** Drawn whenever something ELSE shares the row — the other agent's figures, or the note that
   * stands in for them (see AgentMark.vue for why the mark is drawn rather than picked from the
   * icon set). */
  marked: boolean;
  windows: GaugeWindow[];
}

export interface RateLimitReadout {
  note: string | null;
  gauges: AgentGauge[];
}

/**
 * The whole header readout, decided in ONE pass.
 *
 * The note and the marks are not separable, which is why one function returns both: the note stands
 * where Claude's figures would be, so a Codex row next to it is a second thing on the row and needs
 * saying whose it is. Deciding the mark from "do both agents report" alone made that impossible —
 * the note only appears when Claude reports nothing, so it was ALWAYS unmarked, and
 * `claude usage n/a | 7d 71%` read as Claude's 7d with the 5h missing. It was Codex's (#1161).
 *
 * An agent with nothing to show is dropped rather than rendered empty, and a solo user of either
 * tool still gets no mark — a symbol that distinguishes nothing is one more thing to read.
 */
export function rateLimitReadout(snapshot: RateLimitSnapshot | null, now_ms: number): RateLimitReadout {
  const note = claudeProbeNote(snapshot, now_ms);
  const claude = gaugeWindows(snapshot?.claude ?? null, now_ms);
  const codex = gaugeWindows(snapshot?.codex ?? null, now_ms);
  const marked = note !== null || (claude.length > 0 && codex.length > 0);
  return {
    note,
    gauges: [
      ...(claude.length ? [{ agent: "claude" as const, marked, windows: claude }] : []),
      ...(codex.length ? [{ agent: "codex" as const, marked, windows: codex }] : []),
    ],
  };
}

/** "resets in 2h 15m", or "" when the reset is unknown or already past. The hover text says when
 * the number stops mattering, which is the question that follows "how much is left". */
export function resetsIn(resetsAt_sec: number | null, now_ms: number): string {
  if (resetsAt_sec === null) return "";
  const remaining_min = Math.round((resetsAt_sec * MS_PER_SEC - now_ms) / MS_PER_SEC / SEC_PER_MIN);
  if (remaining_min <= 0) return "";
  const hours = Math.floor(remaining_min / MIN_PER_HOUR);
  const minutes = remaining_min % MIN_PER_HOUR;
  return hours ? `resets in ${hours}h ${minutes}m` : `resets in ${minutes}m`;
}

/** The hover text for one agent — the same numbers plus when each window resets. Also the
 *  `aria-label`, which is why it is built from the SAME list the figures come from: a screen reader
 *  announcing a percentage that is not on screen is worse than one announcing nothing. */
export function gaugeTitle(agent: string, limits: RateLimits | null, now_ms: number): string {
  const parts = liveWindows(limits, now_ms).map(
    ({ label, window }) => `${label} ${Math.round(window.usedPercentage)}% used${suffix(resetsIn(window.resetsAt_sec, now_ms))}`,
  );
  return parts.length ? `${agent} rate limit — ${parts.join(" · ")}` : "";
}

const suffix = (text: string): string => (text ? `, ${text}` : "");
