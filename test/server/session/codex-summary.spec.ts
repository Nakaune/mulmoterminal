// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexSummaryReader } from "../../../server/session/codex-summary.js";

const line = (record: Record<string, unknown>): string => JSON.stringify(record) + "\n";
const start = (id: string): string => line({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
const complete = (id: string, reply: string): string => line({ type: "event_msg", payload: { type: "task_complete", turn_id: id, last_agent_message: reply } });
const user = (text: string): string => line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const exchange = (id: string) => start(id) + user(`request ${id}`) + complete(id, `answer ${id}`);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = (content: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mt-codex-summary-"));
  dirs.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  writeFileSync(file, content);
  return file;
};

describe("Codex summary across appends and restarts", () => {
  it("keeps the prompt and completed reply before more than 4 MiB of tool output after a cold restart", async () => {
    const file = fixture(exchange("one") + line({ type: "response_item", payload: { type: "function_call", arguments: "x".repeat(5 * 1024 * 1024) } }));
    const read = createCodexSummaryReader();
    expect(await read(file)).toMatchObject({ lastPrompt: "request one", lastResponse: "answer one", userTurns: 1 });
    expect(await createCodexSummaryReader()(file)).toEqual(await read(file));
    appendFileSync(file, exchange("two"));
    expect(await read(file)).toMatchObject({ lastPrompt: "request two", lastResponse: "answer two", userTurns: 2 });
  });

  it("does not pair an in-flight prompt with a previous reply", async () => {
    const file = fixture(exchange("one") + start("two") + user("request two"));
    expect(await createCodexSummaryReader()(file)).toMatchObject({
      lastPrompt: "request two",
      lastResponse: "answer one",
      lastComplete: { prompt: "request one", reply: "answer one" },
    });
  });

  it("preserves orphan replies with a null prompt and chooses the nearest matching start", async () => {
    const file = fixture(complete("orphan", "recovered reply"));
    const read = createCodexSummaryReader();
    expect((await read(file)).lastComplete).toEqual({ prompt: null, reply: "recovered reply" });
    appendFileSync(file, start("same") + user("old") + start("same") + user("new") + complete("same", "done"));
    expect((await read(file)).lastComplete).toEqual({ prompt: "new", reply: "done" });
  });

  it("keeps five user turns even across many assistant completions and abandoned starts", async () => {
    const file = fixture(
      Array.from({ length: 40 }, (_, i) => start(String(i)) + user(`request ${i}`)).join("") +
        Array.from({ length: 20 }, (_, i) => complete(`orphan-${i}`, `reply ${i}`)).join(""),
    );
    const value = await createCodexSummaryReader()(file);
    expect(value.titleTurns.filter((turn) => turn.role === "user").map((turn) => turn.text)).toEqual([
      "request 35",
      "request 36",
      "request 37",
      "request 38",
      "request 39",
    ]);
    expect(value.titleTurns).toHaveLength(6);
    expect(value.lastResponse).toBe("reply 19");
  });

  it("resumes partial JSON and gives concurrent readers independent snapshots", async () => {
    const tail = complete("one", "answer one");
    const file = fixture(start("one") + user("request one") + tail.slice(0, 30));
    const read = createCodexSummaryReader();
    const initial = await read(file);
    expect(initial.lastResponse).toBeNull();
    appendFileSync(file, tail.slice(30));
    const [a, b] = await Promise.all([read(file), read(file)]);
    expect(a.lastComplete).toEqual({ prompt: "request one", reply: "answer one" });
    const firstTurn = a.titleTurns[0];
    if (!firstTurn) throw new Error("missing title user turn");
    firstTurn.text = "mutated";
    expect(b.titleTurns[0]?.text).toBe("request one");
    expect((await read(file)).userTurns).toBe(1);
  });

  it("invalidates state on atomic replacement by a larger file and on truncation", async () => {
    const file = fixture(exchange("one"));
    const read = createCodexSummaryReader();
    await read(file);
    writeFileSync(file + ".new", exchange("longer replacement") + exchange("second replacement"));
    renameSync(file + ".new", file);
    expect(await read(file)).toMatchObject({ lastPrompt: "request second replacement", userTurns: 2 });
    writeFileSync(file, exchange("x"));
    expect(await read(file)).toMatchObject({ lastPrompt: "request x", userTurns: 1 });
  });
  it("handles out-of-order completions without losing the earlier turn's prompt", async () => {
    const file = fixture(start("one") + user("one") + start("two") + user("two") + complete("two", "second answer") + complete("one", "first answer"));
    expect((await createCodexSummaryReader()(file)).lastComplete).toEqual({ prompt: "one", reply: "first answer" });
  });
});
