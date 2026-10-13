// The rate-limit wire shape, and the one parser for it (#387).
//
// Here rather than on either side because BOTH decide from it: the server reads it back out of its
// own cache file, and the browser reads it off `/api/rate-limits`. Written twice it was written
// twice differently — jscpd caught the copies before they had a chance to drift.
//
// Everything is optional on purpose. A window can be absent because the agent is not installed,
// because the plan is API-key billed, because no session has answered yet, or because upstream
// dropped the field (anthropics/claude-code#40094). None of those are zero, and a gauge reading
// 0% when the truth is 83% is the worst thing this data can do.
import { isRecord } from "./isRecord.js";
import { finiteNumber } from "./finiteNumber.js";

export interface RateLimitWindow {
  usedPercentage: number; // 0-100, fractional
  resetsAt_sec: number | null; // Unix epoch seconds
}

/** A window that belongs to ONE model rather than to the account — Claude's "Current week (Fable)"
 *  (2026-09-06). It carries its own label because the server names it: there is no fixed set of
 *  these to hard-code, and a model added next month arrives with nothing to change here. */
export interface ScopedRateLimitWindow extends RateLimitWindow {
  /** What to call it on screen, already lowercased to sit beside `5h` / `7d`. */
  label: string;
}

export interface RateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  /** Per-model windows, in the order the server gave them. Absent rather than empty on a reading
   *  that predates them, so an old cache file still parses. */
  scoped?: ScopedRateLimitWindow[];
}

export function parseRateLimitWindow(raw: unknown): RateLimitWindow | null {
  if (!isRecord(raw)) return null;
  const used = finiteNumber(raw.usedPercentage);
  return used === null ? null : { usedPercentage: used, resetsAt_sec: finiteNumber(raw.resetsAt_sec) };
}

/** One per-model window, or null when it carries no usable percentage or no name to show it under.
 *  An unlabelled window is dropped rather than given a made-up label: the whole point of it is to
 *  say WHICH model spent the budget. */
export function parseScopedRateLimitWindow(raw: unknown): ScopedRateLimitWindow | null {
  if (!isRecord(raw)) return null;
  const window = parseRateLimitWindow(raw);
  if (window === null) return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  return label === "" ? null : { ...window, label };
}

/** Null when nothing survives, so a caller can tell "nothing to show" from "0% used".
 *
 *  A reading that is ONLY per-model windows still counts: the account windows and the scoped ones
 *  come from the same fetch, but they are separately nullable upstream, and dropping a 74% because
 *  the pair beside it was absent is the same mistake as rendering a missing window as zero. */
export function parseRateLimits(raw: unknown): RateLimits | null {
  if (!isRecord(raw)) return null;
  const fiveHour = parseRateLimitWindow(raw.fiveHour);
  const sevenDay = parseRateLimitWindow(raw.sevenDay);
  const scoped = (Array.isArray(raw.scoped) ? raw.scoped : []).flatMap((entry) => {
    const parsed = parseScopedRateLimitWindow(entry);
    return parsed ? [parsed] : [];
  });
  if (!fiveHour && !sevenDay && scoped.length === 0) return null;
  return scoped.length ? { fiveHour, sevenDay, scoped } : { fiveHour, sevenDay };
}
