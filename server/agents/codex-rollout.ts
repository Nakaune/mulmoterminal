// Finding the newest Codex rollout on disk and reading its tail. The parsing lives next door in
// codex-rate-limits.ts; this half is the filesystem, kept apart so the rules stay testable without
// one.
//
// Only the TAIL is read. A long Codex session's rollout runs to megabytes, the windows are written
// on nearly every event, and the one that matters is the last — so reading the whole file to reach
// its end would be the most expensive way to get the cheapest data source we have.
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readTailLines } from "../infra/jsonl-file.js";

// Enough to hold several events even when one carries a large payload. A rollout whose last
// rate_limits sits further back than this simply reports nothing, which the gauge already handles.
const CODEX_ROLLOUT_TAIL_BYTES = 256 * 1024;

/** The tail of one rollout, at the size Codex needs.
 *
 *  A function rather than an exported number, so no caller can reach `readTailLines` without it.
 *  That is exactly how the size was lost: moving to the shared reader (#998) left the call site
 *  passing no size, which silently inherited a default meant for a Claude transcript — 4 MB
 *  instead of 256 KB, measured at 0.5 ms → 7.9 ms per poll against a 5.9 MB rollout, on the
 *  request path, for the same answer every time. A remembered argument regresses in silence; a
 *  named reader cannot. */
export const readRolloutTail = (file: string): string[] => readTailLines(file, CODEX_ROLLOUT_TAIL_BYTES);

export const codexSessionsDir = (): string => path.join(os.homedir(), ".codex", "sessions");

// More than one rollout is read because the newest file is no longer the same question as the
// newest reading of the budget the gauge shows: two sessions of one account can be on different
// limits at the same time (see isPlanRateLimits in codex-rate-limits.ts), and the busiest session
// is not necessarily the one on the plan. The caller stops at the first file that answers, so this
// count is what it costs only when NONE of them does.
export const ROLLOUT_SEARCH_MAX_FILES = 6;

// The walk below is synchronous and covers the whole sessions tree — hundreds of files on a
// long-standing install — while the refresh route calls it on every poll. Unthrottled, that blocks
// the event loop (every terminal socket with it) on a schedule. Which files are newest changes only
// when Codex starts one, so re-walking within this window can only produce the same answer.
const NEWEST_FILE_CACHE_MS = 30_000;
let cached: { root: string; files: string[]; at_ms: number } | null = null;

/** The most recently modified `*.jsonl` files under the sessions tree, newest first, at most
 * `max`. Codex nests them by date (`2026/07/28/rollout-….jsonl`), so this walks rather than
 * reading one directory. Empty when the tree holds none. */
export function newestRolloutFiles(root: string, now_ms: number, max: number = ROLLOUT_SEARCH_MAX_FILES): string[] {
  if (cached && cached.root === root && now_ms - cached.at_ms < NEWEST_FILE_CACHE_MS) return cached.files.slice(0, max);
  const files = walkForNewest(root, now_ms);
  cached = { root, files, at_ms: now_ms };
  return files.slice(0, max);
}

/** Uncached, so a test can exercise the walk itself without reaching through the cache. Newest
 *  first, and every file the tree holds — the cap is the caller's, so one cache serves any of
 *  them. */
export function walkForNewest(root: string, now_ms: number): string[] {
  if (!existsSync(root)) return [];
  const found: { file: string; stamp_ms: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    const MAX_DEPTH = 5;
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      // A file stamped in the future would win forever; treat it as now rather than trusting it.
      found.push({ file: full, stamp_ms: Math.min(statSync(full).mtimeMs, now_ms) });
    }
  };
  try {
    walk(root, 0);
  } catch {
    // an unreadable subtree costs whatever it held, not the feature
  }
  return [...found].sort((a, b) => b.stamp_ms - a.stamp_ms).map((c) => c.file);
}
