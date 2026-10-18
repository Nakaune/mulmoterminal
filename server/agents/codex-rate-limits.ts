// Codex reports the same two windows as Claude, and gives them away for free: they are written
// into its own rollout file (`~/.codex/sessions/**/*.jsonl`), so reading them costs nothing —
// no injected statusLine, no probe session, no query against the budget being measured.
//
// The shape is Codex's own, and only `window_minutes` says which window is which. The names
// `primary` / `secondary` do NOT mean 5h / 7d: they are whatever the plan defines, so matching on
// the position rather than the duration would silently mislabel a plan with different windows.
//
//   "rate_limits": {
//     "primary":   {"used_percent": 2.0, "window_minutes": 300,   "resets_at": 1783818175},
//     "secondary": {"used_percent": 1.0, "window_minutes": 10080, "resets_at": 1784358265}
//   }
import type { RateLimits, RateLimitWindow } from "./statusline.js";
import { isRecord } from "../../common/isRecord.js";
import { finiteNumber } from "../../common/finiteNumber.js";

const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;
// A plan's window need not be exactly 300 / 10080, and a near-miss classified as "neither" would
// drop a window the user can see in Codex itself. Nearest match wins, within this much.
const WINDOW_TOLERANCE_MINUTES = 60;

// One account can have SEVERAL of these objects in flight at once, and they are different budgets.
// Measured on 2026-08-27: a session on the plan reported
//   {"limit_id":"codex","limit_name":null,"primary":{…10080 min, 22%},"secondary":null,"plan_type":"prolite"}
// while another session — the same account, a model with a pool of its own — reported
//   {"limit_id":"codex_bengalfox","limit_name":"GPT-5.3-Codex-Spark","primary":{…300 min, 0%},"plan_type":null}
// Taking whichever was written last therefore showed 0% while 22% of the plan's week was spent.
// Re-measured on 2026-09-06, the same pool now reports "plan_type":"prolite" — the field moved,
// which is why isPlanRateLimits below no longer takes it as proof (it still reads 0% / 0%, and the
// plan read 72%). `limit_name` is the half that has stayed honest: null on the plan, the model's
// own name on a pool.
// The gauge exists to answer "how much of MY quota is left", so it follows the plan's own limit.
const PLAN_LIMIT_ID = "codex";

/**
 * Does this `rate_limits` object describe the ACCOUNT PLAN's quota, rather than one model's pool?
 *
 * `limit_name` is asked FIRST and answers no on its own: it is the pool's own label
 * ("GPT-5.3-Codex-Spark") and the plan bucket leaves it null. Nothing else may overrule it.
 *
 * That order is the fix for a gauge that sat at 0% while 72% of the plan's week was spent
 * (2026-09-06). `plan_type` used to be enough by itself, on the reasoning that only the plan
 * carried it — and then the Spark pool started carrying `"plan_type":"prolite"` too, so the
 * newest rollout, a pool's, was accepted as the plan's. The subscription's name describes the
 * ACCOUNT, and both buckets belong to the same account; it was never a statement about which
 * budget this is, which is why it was the wrong question to ask first.
 *
 * With the pool ruled out, `limit_id` decides — `codex` for the plan, a suffixed id for a pool —
 * and `plan_type` is left as the fallback for a bucket that names neither, so an upstream that
 * drops `limit_id` costs the gauge nothing.
 */
export function isPlanRateLimits(rateLimits: unknown): boolean {
  if (!isRecord(rateLimits)) return false;
  if (typeof rateLimits.limit_name === "string" && rateLimits.limit_name !== "") return false;
  if (typeof rateLimits.limit_id === "string" && rateLimits.limit_id !== "") return rateLimits.limit_id === PLAN_LIMIT_ID;
  return typeof rateLimits.plan_type === "string" && rateLimits.plan_type !== "";
}

/** Which `rate_limits` objects a search will accept. */
export type RateLimitFilter = (rateLimits: unknown) => boolean;
const ANY_RATE_LIMITS: RateLimitFilter = () => true;

interface CodexWindow {
  window: RateLimitWindow;
  minutes: number;
}

function windowFrom(raw: unknown): CodexWindow | null {
  if (!isRecord(raw)) return null;
  const used = finiteNumber(raw.used_percent);
  const minutes = finiteNumber(raw.window_minutes);
  if (used === null || minutes === null) return null;
  return { window: { usedPercentage: used, resetsAt_sec: finiteNumber(raw.resets_at) }, minutes };
}

const closestTo = (target: number, candidates: readonly CodexWindow[]): RateLimitWindow | null => {
  const near = candidates.filter((c) => Math.abs(c.minutes - target) <= WINDOW_TOLERANCE_MINUTES);
  if (near.length === 0) return null;
  return near.reduce((best, c) => (Math.abs(c.minutes - target) < Math.abs(best.minutes - target) ? c : best)).window;
};

/**
 * The two windows out of one Codex `rate_limits` object, or null when neither is usable — same
 * contract as the Claude extractor, so the store and the UI never learn which agent they came
 * from.
 */
export function extractCodexRateLimits(rateLimits: unknown): RateLimits | null {
  if (!isRecord(rateLimits)) return null;
  const windows = [rateLimits.primary, rateLimits.secondary].flatMap((raw) => {
    const parsed = windowFrom(raw);
    return parsed ? [parsed] : [];
  });
  const fiveHour = closestTo(FIVE_HOUR_MINUTES, windows);
  const sevenDay = closestTo(SEVEN_DAY_MINUTES, windows);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

/**
 * The newest `rate_limits` in a rollout file's lines, reading from the END: the last one written
 * is the current state, and a session that ran for hours holds many. Lines that are not JSON are
 * skipped rather than failing the file — a rollout being appended to while we read it can leave a
 * partial last line.
 *
 * `accept` narrows WHICH budget is wanted (see isPlanRateLimits). Unfiltered by default, so a
 * caller that has no opinion keeps the old meaning of "the newest one, whatever it was about".
 */
export function latestRateLimitsInRollout(lines: readonly string[], accept: RateLimitFilter = ANY_RATE_LIMITS): RateLimits | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.includes("rate_limits")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const found = findRateLimits(parsed, accept);
      if (found) return found;
    } catch {
      // not a complete JSON line; keep looking further back
    }
  }
  return null;
}

// What the search may descend into — a different question from `isRecord`, which answers "may I
// read named fields off this". An array must fail that one and pass this one.
function childrenOf(node: unknown): unknown[] {
  if (isRecord(node)) return Object.values(node);
  return Array.isArray(node) ? node : [];
}

// `rate_limits` sits inside a record whose surrounding shape is Codex's business and has changed
// before. Searching for the key rather than a fixed path means a re-nesting upstream costs nothing.
//
// Arrays are descended into as well as records (see childrenOf): a `content: []` on the path is one
// of the shapes this search exists to survive, and stopping there would blank the gauge with nothing
// on screen to explain it.
function findRateLimits(node: unknown, accept: RateLimitFilter, depth = 0): RateLimits | null {
  const MAX_DEPTH = 6;
  if (depth > MAX_DEPTH) return null;
  if (isRecord(node) && isRecord(node.rate_limits) && accept(node.rate_limits)) {
    const extracted = extractCodexRateLimits(node.rate_limits);
    if (extracted) return extracted;
  }
  for (const value of childrenOf(node)) {
    const found = findRateLimits(value, accept, depth + 1);
    if (found) return found;
  }
  return null;
}
