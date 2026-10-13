import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { cleanTitle, parseJsonRecord, readTranscriptHead } from "./transcript-head.js";
import { byCodeUnit } from "../../common/byCodeUnit.js";
import { codexUserTurnText } from "./codex-user-turn.js";
import { parseSessionMetaRecord } from "./codex-session.js";

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024; // enough for session_meta + the first user turn
const DEFAULT_TITLE = "Codex session";
const SCAN_LIMIT = 200; // newest rollout files to inspect per request

export interface CodexSessionSummary {
  id: string;
  title: string;
  mtime: number;
}

interface RolloutHead {
  id: string;
  cwd: string | null;
  title: string;
}

// From a rollout's head, pull the minted id + cwd (session_meta) and a title (first user message).
// Returns null if there's no valid session_meta.
export function parseCodexRolloutHead(head: string): RolloutHead | null {
  const docs = head
    .split("\n")
    .map(parseJsonRecord)
    .filter((d): d is Record<string, unknown> => d !== null);
  const meta = docs.map(parseSessionMetaRecord).find((value) => value !== null);
  if (!meta) return null;
  const firstUserTurn = docs.map(codexUserTurnText).find((text): text is string => text !== null);
  return { ...meta, title: cleanTitle(firstUserTurn ?? null, DEFAULT_TITLE) };
}

function subdirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(byCodeUnit)
      .reverse();
  } catch {
    return [];
  }
}

// Every YYYY/MM/DD directory under the sessions root, newest first.
function dayDirsDesc(root: string): string[] {
  return subdirsDesc(root).flatMap((year) =>
    subdirsDesc(path.join(root, year)).flatMap((month) => subdirsDesc(path.join(root, year, month)).map((day) => path.join(root, year, month, day))),
  );
}

function rolloutsInDay(dayDir: string): string[] {
  return readdirSync(dayDir)
    .filter((n) => ROLLOUT_RE.test(n))
    .sort(byCodeUnit)
    .reverse()
    .map((f) => path.join(dayDir, f));
}

// Rollout paths newest-first (the filename embeds an ISO timestamp), capped to `scan` so a long
// history stays cheap — only these get their heads read.
function recentRolloutPaths(root: string, scan: number): string[] {
  if (!existsSync(root)) return [];
  return dayDirsDesc(root).flatMap(rolloutsInDay).slice(0, scan);
}

async function readRolloutSummary(file: string): Promise<(RolloutHead & { mtime: number }) | null> {
  const read = await readTranscriptHead(file, HEAD_BYTES);
  if (!read) return null;
  const head = parseCodexRolloutHead(read.head);
  return head && { ...head, mtime: read.mtime };
}

// The rollout file for this id, or null. The id is the filename suffix, so the search reads
// directory names only. Newest day first, so the answer is found near the front for a live session.
export function codexRolloutPath(root: string, id: string): string | null {
  if (!UUID_RE.test(id) || !existsSync(root)) return null;
  const suffix = `-${id}.jsonl`;
  for (const dayDir of dayDirsDesc(root)) {
    try {
      const name = readdirSync(dayDir).find((n) => ROLLOUT_RE.test(n) && n.endsWith(suffix));
      if (name) return path.join(dayDir, name);
    } catch {
      // a day dir that vanished mid-scan — keep looking
    }
  }
  return null;
}

// Does a rollout with this id exist? Lets a sidebar-listed codex session be resumed by its
// rollout id (`codex resume <id>`).
export const codexRolloutExists = (root: string, id: string): boolean => codexRolloutPath(root, id) !== null;

// codex sessions for a workspace, newest first — the single view's sidebar list. Scans the most
// recent rollout files, keeps those whose recorded cwd matches, and returns the top `limit`.
export async function listCodexSessions(root: string, cwd: string, limit: number): Promise<CodexSessionSummary[]> {
  const summaries = await Promise.all(recentRolloutPaths(root, SCAN_LIMIT).map(readRolloutSummary));
  return summaries
    .filter((s): s is RolloutHead & { mtime: number } => s !== null && s.cwd === cwd)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((s) => ({ id: s.id, title: s.title, mtime: s.mtime }));
}
