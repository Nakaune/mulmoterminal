// Claude's per-model weekly windows — the "Current week (Fable)" row of `/usage` — read from the
// file Claude Code already keeps them in (`~/.claude.json`), the same free-on-disk bargain the
// Codex gauge gets from a rollout (codex-rollout.ts).
//
// It is read here rather than taken from the probe's status line because the status line does not
// carry it. Measured on 2.1.263, 2026-09-06: a session's `rate_limits` payload holds `five_hour`
// and `seven_day` only, while `/usage` on the same account, the same minute, drew
// "Current week (Fable) 74% used". Claude Code does project the per-model windows into the status
// line (`rate_limits.model_scoped`), but filters them by an overage-included-models allowlist that
// this account's Fable bucket is not on — so waiting for them there is waiting for nothing.
//
// What both of them read is this, written by whichever `claude` last fetched usage:
//
//   "cachedUsageUtilization": {
//     "fetchedAtMs": 1788707545160,
//     "utilization": { "five_hour": {...}, "seven_day": {...}, "limits": [
//       {"kind":"session",        "percent":10, "resets_at":"…", "scope":null},
//       {"kind":"weekly_all",     "percent":46, "resets_at":"…", "scope":null},
//       {"kind":"weekly_scoped",  "percent":74, "resets_at":"…",
//        "scope":{"model":{"id":null,"display_name":"Fable"}}}
//     ]}}
//
// Only the SCOPED rows are taken. The other two are the 5h and 7d the probe already reports, and
// reading the same number from two places is how two places come to disagree.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ScopedRateLimitWindow } from "../../common/rateLimits.js";
import { isRecord } from "../../common/isRecord.js";
import { finiteNumber } from "../../common/finiteNumber.js";

/** Where Claude Code keeps it. `CLAUDE_CONFIG_DIR` moves the rest of Claude's state, and this file
 *  with it, so honouring it costs one line and not honouring it would silently read a file that
 *  belongs to a different account. */
export const claudeUsageCacheFile = (): string => {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
};

// Nothing refreshes this file on a schedule: it is written by whichever `claude` process last
// asked the server for usage, which here is the rate-limit probe. So an unread gauge, a probe that
// cannot run, or an uninstalled Claude all leave the last fetch sitting on disk indefinitely — and
// a weekly window's own reset is days away, so staleness cannot be inferred from the window the
// way it can for the 5h one. The stamp is the only thing that says how old the number is, and past
// this it stops being a fact about now.
//
// The same hour as CLAUDE_READING_MAX_AGE_MS, and for the same reason: past one full probe-retry
// cycle with nothing new, the gauge should stop vouching for what it holds.
export const USAGE_CACHE_MAX_AGE_MS = 60 * 60_000;

/** Unix seconds from the ISO timestamp Claude writes, or null when it is absent or unparseable —
 *  never a guess, because the reset time is what the gauge uses to decide a window is spent. */
export function isoToEpochSec(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/** The per-model windows in one parsed `~/.claude.json`, in the order Claude listed them.
 *
 *  Empty for every kind of absence — no cache, an account with no scoped limit, a shape that
 *  moved — because there is nothing useful to say differently about any of them, and the header
 *  simply shows one figure fewer. */
export function scopedWindowsFromConfig(config: unknown, now_ms: number): ScopedRateLimitWindow[] {
  if (!isRecord(config)) return [];
  const cached = config.cachedUsageUtilization;
  if (!isRecord(cached)) return [];
  const fetchedAt_ms = finiteNumber(cached.fetchedAtMs);
  if (fetchedAt_ms === null || now_ms - fetchedAt_ms > USAGE_CACHE_MAX_AGE_MS) return [];
  const utilization = cached.utilization;
  if (!isRecord(utilization) || !Array.isArray(utilization.limits)) return [];
  return utilization.limits.flatMap((entry) => {
    const window = scopedWindow(entry);
    return window ? [window] : [];
  });
}

// `kind` is what says this row is one model's own budget; `scope.model.display_name` is the label
// the server chose for it, and is used verbatim (lowercased) rather than mapped to a name of our
// own — a model added next month then needs no change here.
function scopedWindow(entry: unknown): ScopedRateLimitWindow | null {
  if (!isRecord(entry) || entry.kind !== "weekly_scoped") return null;
  const percent = finiteNumber(entry.percent);
  if (percent === null) return null;
  const scope = entry.scope;
  const model = isRecord(scope) ? scope.model : null;
  const name = isRecord(model) && typeof model.display_name === "string" ? model.display_name.trim() : "";
  if (name === "") return null;
  return { label: name.toLowerCase(), usedPercentage: percent, resetsAt_sec: isoToEpochSec(entry.resets_at) };
}

/** The windows on disk right now. A file that is missing, locked, half-written or not JSON reports
 *  nothing — this runs on the poll path beside the Codex read, and neither may take the request
 *  down over a file that belongs to another program. */
export function readClaudeScopedWindows(file: string, now_ms: number): ScopedRateLimitWindow[] {
  try {
    return scopedWindowsFromConfig(JSON.parse(readFileSync(file, "utf8")), now_ms);
  } catch {
    return [];
  }
}

/** When claude last wrote the cache, or null when there is no cache or it cannot be read. The probe
 *  polls this after sending `/usage` (rate-limit-probe.ts): a change in the stamp is the one signal
 *  that the per-model windows above have been refreshed, independent of what the screen shows. */
export function readUsageCacheFetchedAt(file: string): number | null {
  try {
    const config: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(config) || !isRecord(config.cachedUsageUtilization)) return null;
    return finiteNumber(config.cachedUsageUtilization.fetchedAtMs);
  } catch {
    return null;
  }
}
