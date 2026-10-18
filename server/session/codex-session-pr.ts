import { promises as fs, createReadStream } from "node:fs";
import { forEachJsonlRecordIn } from "../infra/jsonl-file.js";
import { createAppendFileCache, type FileStamp } from "./file-cache.js";
// A Codex session's pull requests, read from its rollout file.
//
// The Claude side of this feature is fed by events: every finished tool call reaches the server
// through the hook route, so `record` sees a request the moment it is opened. Codex sends nothing —
// its cells are plain terminals with no hook and no MCP — so the only record of what it ran is the
// rollout on disk, and the only way to answer is to read it.
//
// That difference decides the shape here: this is a DERIVATION, not a writer. Nothing persists, so
// there is no state to keep in step with a file that Codex is still appending to, and a rollout
// that grows re-derives the same requests plus whatever is new.
import { isRecord } from "../../common/isRecord.js";
import { finiteNumber } from "../../common/finiteNumber.js";
import { codexPrFromExec, execCommandsIn, ghPrVerbs } from "../../common/codexSessionPr.js";
import { foldSessionPr, sortedSessionPrs, type SessionPr } from "../../common/sessionPr.js";

// Bigger than the rate-limit reader's 256KB (codex-rollout.ts) because the two ask opposite
// questions: that one wants the LAST windows and stops at the first it finds, this one wants
// everything the session did and a request opened at the start of a long session is exactly the one
// the chip should still be showing. A named reader for the same reason stated there — a size passed
// at the call site regresses in silence.
export interface CodexPrScan {
  inputById: Map<string, unknown>;
  prs: SessionPr[];
}

export const emptyCodexPrScan = (): CodexPrScan => ({ inputById: new Map(), prs: [] });

// Codex stores a command's output as the content blocks the model was shown. Joined rather than
// searched block by block: gh prints the url on its own line, and a block boundary must not be able
// to hide it.
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n");
}

// When the call happened, in ms. Codex stamps `create_time` in SECONDS beside each record; without
// it the list would sort by nothing and a request from last week could sit above this morning's.
function stampMs(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  for (const key of ["timestamp", "created_at", "createdAt"]) {
    const value = payload[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!isRecord(meta)) return null;
  const seconds = finiteNumber(meta.create_time);
  return seconds === null ? null : Math.round(seconds * 1000);
}

/**
 * Every request the rollout shows this session acting on, newest act first.
 *
 * A call and its output are two separate records joined by `call_id`, and the command is on the
 * CALL — so an output whose call fell off the front of the tail is skipped rather than read on its
 * own. That is the conservative direction: without the command there is no way to tell a `gh pr
 * create` from a `gh pr list`, and codexSessionPr.ts exists to keep those apart.
 */
export function codexPrsFromRollout(lines: readonly string[], fallbackAt: number): SessionPr[] {
  const scan = emptyCodexPrScan();
  for (const line of lines) {
    const parsed = parseExecRecord(line);
    if (parsed) foldCodexPrRecord(scan, parsed, fallbackAt);
  }
  return sortedSessionPrs(scan.prs);
}

const MAX_PENDING_PR_CALLS = 256;
interface CodexPrRecord {
  callId: string;
  payload: Record<string, unknown>;
  timestamp?: unknown;
}

export function foldCodexPrRecord(scan: CodexPrScan, record: CodexPrRecord, fallbackAt: number): void {
  if (record.payload.type === "custom_tool_call") {
    const { writes, reads } = ghPrVerbs(execCommandsIn(record.payload.input));
    if (!writes.length || reads.length) return;
    scan.inputById.set(record.callId, record.payload.input);
    // An abandoned tool call must not retain arbitrarily many programs. Only PR
    // writes are pending; an output beyond this outstanding-call cap stays unattributed.
    if (scan.inputById.size > MAX_PENDING_PR_CALLS) {
      const oldest = scan.inputById.keys().next().value;
      if (oldest !== undefined) scan.inputById.delete(oldest);
    }
    return;
  }
  const input = scan.inputById.get(record.callId);
  if (input === undefined) return;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  const pr = codexPrFromExec(input, outputText(record.payload.output), stampMs(record.payload) ?? (Number.isFinite(timestamp) ? timestamp : fallbackAt));
  scan.inputById.delete(record.callId);
  if (pr) foldSessionPr(scan.prs, pr);
}

/** One rollout line as the loop above needs it: an exec call or its output, with the id that joins
 *  them. Null for everything else, which is most of the file. */
function parseExecRecord(line: string): CodexPrRecord | null {
  if (!line.includes("custom_tool_call")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A rollout being appended to while we read it can leave a partial line.
    return null;
  }
  if (!isRecord(parsed)) return null;
  const payload = parsed.payload;
  if (!isRecord(payload) || typeof payload.call_id !== "string") return null;
  if (payload.type !== "custom_tool_call" && payload.type !== "custom_tool_call_output") return null;
  return { callId: payload.call_id, payload, timestamp: parsed.timestamp };
}

export function createCodexPrReader(codexRolloutFile?: (sessionId: string) => string | null | Promise<string | null>) {
  // A Codex session's answer is DERIVED on every read rather than seeded once, because there is no
  // event to update it with: nothing tells this server that a cell just opened a request, so a
  // one-shot seed would freeze the chip at whatever the session had done by its first read. Keyed
  // on the rollout's stamp so the append scan happens when Codex has written, not when the browser
  // has polled.
  const codexSeen = createAppendFileCache<CodexPrScan>();
  const codexScanning = new Map<string, Promise<SessionPr[]>>();

  async function codexPrs(sessionId: string): Promise<SessionPr[]> {
    const running = codexScanning.get(sessionId);
    if (running) return running;
    const result = codexPrsUnserialized(sessionId);
    codexScanning.set(sessionId, result);
    try {
      return await result;
    } finally {
      codexScanning.delete(sessionId);
    }
  }

  async function codexPrsUnserialized(sessionId: string): Promise<SessionPr[]> {
    const file = (await codexRolloutFile?.(sessionId)) ?? null;
    if (!file) return [];
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return [];
    }
    const prefix = await readRolloutPrefix(file);
    const cacheKey = `${file}\0${prefix}`;
    const stamp: FileStamp = { mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino };
    const resumed = codexSeen.resume(cacheKey, stamp);
    if (resumed && resumed.from === stamp.size) return sortedSessionPrs(resumed.value.prs);
    const scan = resumed ? { inputById: new Map(resumed.value.inputById), prs: resumed.value.prs.map((pr) => ({ ...pr })) } : emptyCodexPrScan();
    const from = resumed?.from ?? 0;
    const fallbackAt = stat.birthtimeMs || stat.mtimeMs;
    const next = await forEachJsonlRecordIn(file, { from, atLineStart: true }, (record) => {
      if (
        record.payload &&
        isRecord(record.payload) &&
        typeof record.payload.call_id === "string" &&
        (record.payload.type === "custom_tool_call" || record.payload.type === "custom_tool_call_output")
      ) {
        foldCodexPrRecord(scan, { callId: record.payload.call_id, payload: record.payload, timestamp: record.timestamp }, fallbackAt);
      }
    });
    codexSeen.set(cacheKey, stamp, next, scan);
    return scan.prs;
  }

  async function readRolloutPrefix(file: string): Promise<string> {
    return await new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(file, { start: 0, end: 255 });
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      stream.on("error", () => resolve(""));
    });
  }

  return codexPrs;
}
