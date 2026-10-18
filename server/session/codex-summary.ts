import { stat } from "node:fs/promises";
import { forEachJsonlRecordIn } from "../infra/jsonl-file.js";
import { createAppendFileCache, type FileStamp } from "./file-cache.js";
import { preferredHeaderPrompt, type ConversationTurn } from "./transcript.js";
import { codexEventPayload } from "../agents/codex-events.js";
import { codexUserTurnText } from "../agents/codex-user-turn.js";
import type { LastTurn } from "./last-turn.js";

interface CodexSummaryState {
  userTurns: number;
  latestPrompt: string | null;
  open: Array<{ id: string | null; prompt: string | null }>;
  lastComplete: LastTurn;
  titleUsers: ConversationTurn[];
  latestAssistant: ConversationTurn | null;
}

const empty = (): CodexSummaryState => ({
  userTurns: 0,
  latestPrompt: null,
  open: [],
  lastComplete: { prompt: null, reply: null },
  titleUsers: [],
  latestAssistant: null,
});
const copy = (s: CodexSummaryState): CodexSummaryState => ({
  ...s,
  open: s.open.map((x) => ({ ...x })),
  lastComplete: { ...s.lastComplete },
  titleUsers: s.titleUsers.map((turn) => ({ ...turn })),
  latestAssistant: s.latestAssistant && { ...s.latestAssistant },
});
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function fold(s: CodexSummaryState, doc: Record<string, unknown>): void {
  const user = codexUserTurnText(doc);
  if (user) {
    s.userTurns += 1;
    s.latestPrompt = preferredHeaderPrompt(s.latestPrompt, user);
    const current = s.open[s.open.length - 1];
    if (current) current.prompt ??= user;
    s.titleUsers.push({ role: "user", text: user });
    if (s.titleUsers.length > 5) s.titleUsers.shift();
    return;
  }
  const started = codexEventPayload(doc, "task_started");
  if (started) {
    s.open.push({ id: text(started.turn_id), prompt: null });
    if (s.open.length > 32) s.open.splice(0, s.open.length - 32);
    return;
  }
  const complete = codexEventPayload(doc, "task_complete");
  if (!complete) return;
  const id = text(complete.turn_id);
  const index = s.open.findLastIndex((turn) => id === null || turn.id === id);
  const turn = s.open[index];
  // Keep the bounded start history: completions can arrive out of order or be
  // repeated. Consuming another turn's start would pair a later reply incorrectly.
  const reply = text(complete.last_agent_message);
  if (!reply) return;
  s.lastComplete = { prompt: turn?.prompt ?? null, reply };
  s.latestAssistant = { role: "assistant", text: reply };
}

export interface CodexSummarySnapshot {
  lastPrompt: string | null;
  lastResponse: string | null;
  userTurns: number;
  titleTurns: ConversationTurn[];
  lastComplete: LastTurn;
}

async function scanCodexSummary(file: string, cache: ReturnType<typeof createAppendFileCache<CodexSummaryState>>): Promise<CodexSummarySnapshot> {
  const st = await stat(file);
  const stamp: FileStamp = { mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino };
  const prior = cache.resume(file, stamp);
  const state = prior ? copy(prior.value) : empty();
  const from = prior?.from ?? 0;
  const offset = from === st.size ? from : await forEachJsonlRecordIn(file, { from, atLineStart: from > 0 }, (record) => fold(state, record));
  cache.set(file, stamp, offset, copy(state));
  return {
    lastPrompt: state.latestPrompt,
    lastResponse: state.lastComplete.reply,
    userTurns: state.userTurns,
    titleTurns: [...state.titleUsers, ...(state.latestAssistant ? [state.latestAssistant] : [])],
    lastComplete: { ...state.lastComplete },
  };
}

export function createCodexSummaryReader(): (file: string) => Promise<CodexSummarySnapshot> {
  const cache = createAppendFileCache<CodexSummaryState>();
  const inFlight = new Map<string, Promise<CodexSummarySnapshot>>();
  return async (file) => {
    let next = inFlight.get(file);
    if (!next) {
      next = scanCodexSummary(file, cache).finally(() => inFlight.delete(file));
      inFlight.set(file, next);
    }
    const result = await next;
    return { ...result, lastComplete: { ...result.lastComplete }, titleTurns: result.titleTurns.map((turn) => ({ ...turn })) };
  };
}

export const readCodexSummary = createCodexSummaryReader();
