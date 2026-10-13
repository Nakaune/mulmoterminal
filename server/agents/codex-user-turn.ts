// The user's text in a Codex rollout. Older rollouts record it as an event_msg;
// current Codex writes a response_item/message instead. The latter also carries
// startup context as a user-role message, so callers must not treat every such
// row as the user's task.
import { isRecord } from "../../common/isRecord.js";
import { codexEventPayload } from "./codex-events.js";

const injectedUserText = (text: string): boolean =>
  /^# AGENTS\.md instructions for /u.test(text) || /^<(?:environment_context|recommended_plugins|user_action|turn_aborted)(?:\s|>)/u.test(text);

const responseItemUserText = (doc: Record<string, unknown>): string | null => {
  if (doc.type !== "response_item" || !isRecord(doc.payload) || doc.payload.type !== "message" || doc.payload.role !== "user") return null;
  if (!Array.isArray(doc.payload.content)) return null;
  const blocks = doc.payload.content
    .filter((block): block is Record<string, unknown> & { text: string } => isRecord(block) && block.type === "input_text" && typeof block.text === "string")
    .map((block) => block.text.trim());
  if (blocks.some(injectedUserText)) return null;
  const text = blocks.join("\n").trim();
  return text && !injectedUserText(text) ? text : null;
};

/** A real user task from either Codex rollout format, excluding startup context. */
export function codexUserTurnText(doc: Record<string, unknown>): string | null {
  const legacy = codexEventPayload(doc, "user_message")?.message;
  if (typeof legacy === "string" && legacy.trim() && !injectedUserText(legacy.trim())) return legacy.trim();
  return responseItemUserText(doc);
}
