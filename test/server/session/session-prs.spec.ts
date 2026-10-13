// The session's PR history as the store actually keeps it: recorded off a finished tool call,
// and — for a session that was already running when this arrived — seeded from the call history
// that is already on disk. Both paths feed the same chip, so both are pinned here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolStores } from "../../../server/session/tool-store";

const SESSION = "0c41a6e8-9566-45e2-bf22-66cc1f93095f";
const OTHER = "17886256-7071-4755-917c-e771234afcfa";
const url = (n: number) => `https://github.com/Nakaune/AidaNote/pull/${n}`;
const rolloutCall = (id: string, command: string) =>
  JSON.stringify({
    payload: {
      type: "custom_tool_call",
      call_id: id,
      input: `const r = await tools.exec_command({cmd: ${JSON.stringify(command)}}); text(r.output);`,
      internal_chat_message_metadata_passthrough: { create_time: 1_700_000_000 },
    },
  });
const rolloutOutput = (id: string, n: number) =>
  JSON.stringify({
    payload: {
      type: "custom_tool_call_output",
      call_id: id,
      output: [{ text: `https://github.com/Nakaune/AidaNote/pull/${n}` }],
      internal_chat_message_metadata_passthrough: { create_time: 1_700_000_001 },
    },
  });

// What Claude Code attaches to a Bash result after `gh pr create` / `gh pr edit`. The rest of the
// object is the ordinary shell result, and is what makes this NOT a special-cased command parse.
const bashResult = (n: number, action: string) => ({
  stdout: url(n),
  stderr: "",
  interrupted: false,
  gitOperation: { pr: { number: n, url: url(n), action } },
});

let root: string;
const stores = () => createToolStores({ publish: () => {}, root });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mt-session-prs-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const endCall = (s: ReturnType<typeof stores>, session: string, id: string, output: unknown) =>
  s.recordToolCallEnd(session, { toolUseId: id, toolName: "Bash", toolInput: { command: "gh pr create" }, toolOutput: output, status: "completed" });

describe("the session's PR history", () => {
  it("records what a finished tool did to a request", async () => {
    const s = stores();
    await endCall(s, SESSION, "t1", bashResult(1146, "created"));
    expect(await s.getSessionPrs(SESSION)).toMatchObject([{ number: 1146, url: url(1146), repo: "Nakaune/AidaNote", created: true }]);
  });

  // A read is not an act. `gh pr view` carries no gitOperation, which is the whole reason this
  // needs no command parsing — and the reason a session that only LOOKED at a request says so.
  it("ignores a tool call that only read a request", async () => {
    const s = stores();
    await endCall(s, SESSION, "t1", { stdout: url(1146), stderr: "", interrupted: false });
    expect(await s.getSessionPrs(SESSION)).toEqual([]);
  });

  it("keeps one entry per request, and keeps the fact that this session opened it", async () => {
    const s = stores();
    await endCall(s, SESSION, "t1", bashResult(1146, "created"));
    await endCall(s, SESSION, "t2", bashResult(1146, "edited"));
    expect(await s.getSessionPrs(SESSION)).toMatchObject([{ number: 1146, created: true }]);
  });

  it("keeps each session's requests to itself", async () => {
    const s = stores();
    await endCall(s, SESSION, "t1", bashResult(1146, "created"));
    await endCall(s, OTHER, "t2", bashResult(9, "created"));
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
    expect((await s.getSessionPrs(OTHER)).map((p) => p.number)).toEqual([9]);
  });

  it("survives a restart: the record is on disk, not only in memory", async () => {
    await endCall(stores(), SESSION, "t1", bashResult(1146, "created"));
    expect((await stores().getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
  });

  // The reason the chip is not blank for a session that was mid-flight when this shipped: its
  // `gh pr create` is already in the call history, with the output the recorder would have read.
  it("seeds itself from the call history it has never recorded", async () => {
    await fs.mkdir(path.join(root, "toolcalls"), { recursive: true });
    await fs.writeFile(
      path.join(root, "toolcalls", `${SESSION}.json`),
      JSON.stringify([
        { toolName: "Bash", toolOutput: bashResult(1146, "created"), status: "completed", at: 100 },
        { toolName: "Bash", toolOutput: bashResult(1150, "edited"), status: "completed", at: 200 },
      ]),
    );
    // Newest act first — 1150 was edited after 1146 was opened.
    expect((await stores().getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1150, 1146]);
  });

  // A GET must not write (routes/same-origin-guard.ts), so the seed stays in memory. The call
  // history it was derived from is itself on disk, so nothing is lost by not persisting it.
  it("does not write the seed to disk", async () => {
    await fs.mkdir(path.join(root, "toolcalls"), { recursive: true });
    await fs.writeFile(
      path.join(root, "toolcalls", `${SESSION}.json`),
      JSON.stringify([{ toolName: "Bash", toolOutput: bashResult(1146, "created"), status: "completed", at: 100 }]),
    );
    const s = stores();
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
    await expect(fs.readFile(path.join(root, "sessionprs", `${SESSION}.json`), "utf8")).rejects.toThrow();
  });

  it("reads Codex PRs before the old tail and survives a fresh reader", async () => {
    const rollout = path.join(root, "rollout.jsonl");
    await fs.writeFile(rollout, `${rolloutCall("c1", "gh pr create --fill")}\n${rolloutOutput("c1", 1146)}\n${"x".repeat(4 * 1024 * 1024)}\n`);
    const reader = () => createToolStores({ publish: () => {}, root, codexRolloutFile: async () => rollout });
    expect((await reader().getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
    expect((await reader().getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
  });

  it("keeps a Codex call pending when its output arrives in a later append", async () => {
    const rollout = path.join(root, "rollout.jsonl");
    await fs.writeFile(rollout, `${rolloutCall("c1", "gh pr create --fill")}\n`);
    const reader = createToolStores({ publish: () => {}, root, codexRolloutFile: () => rollout });
    expect(await reader.getSessionPrs(SESSION)).toEqual([]);
    await fs.appendFile(rollout, `${rolloutOutput("c1", 1146)}\n`);
    expect((await reader.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
  });

  it("does not lose Claude seed data on a repeated read", async () => {
    await fs.mkdir(path.join(root, "toolcalls"), { recursive: true });
    await fs.writeFile(
      path.join(root, "toolcalls", `${SESSION}.json`),
      JSON.stringify([{ toolOutput: bashResult(1146, "created"), status: "completed", at: 100 }]),
    );
    const s = stores();
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
  });

  it("switches rollout mappings without carrying PRs between files", async () => {
    const first = path.join(root, "first.jsonl");
    const second = path.join(root, "second.jsonl");
    await fs.writeFile(first, `${rolloutCall("a", "gh pr create --fill")}\n${rolloutOutput("a", 1146)}\n`);
    await fs.writeFile(second, `${rolloutCall("b", "gh pr create --fill")}\n${rolloutOutput("b", 1150)}\n`);
    let current = first;
    const s = createToolStores({ publish: () => {}, root, codexRolloutFile: () => current });
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
    current = second;
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1150]);
  });

  it("restarts from zero after truncation or replacement", async () => {
    const rollout = path.join(root, "replace.jsonl");
    await fs.writeFile(rollout, `${rolloutCall("a", "gh pr create --fill")}\n${rolloutOutput("a", 1146)}\n`);
    const s = createToolStores({ publish: () => {}, root, codexRolloutFile: () => rollout });
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1146]);
    await fs.writeFile(rollout, `${rolloutCall("b", "gh pr create --fill")}\n${rolloutOutput("b", 1150)}\n${"z".repeat(300)}\n`);
    expect((await s.getSessionPrs(SESSION)).map((p) => p.number)).toEqual([1150]);
    await fs.truncate(rollout, 0);
    expect(await s.getSessionPrs(SESSION)).toEqual([]);
  });
  it("resumes partial output during concurrent reads without mutating Claude history", async () => {
    await fs.mkdir(path.join(root, "toolcalls"), { recursive: true });
    await fs.writeFile(
      path.join(root, "toolcalls", `${SESSION}.json`),
      JSON.stringify([{ toolOutput: bashResult(1146, "edited"), status: "completed", at: 100 }]),
    );
    const rollout = path.join(root, "partial.jsonl");
    const output = rolloutOutput("partial", 1146);
    await fs.writeFile(rollout, rolloutCall("partial", "gh pr create --fill") + "\n" + output.slice(0, 30));
    let current: string | null = rollout;
    const reader = createToolStores({ publish: () => {}, root, codexRolloutFile: () => current });
    expect((await reader.getSessionPrs(SESSION))[0]?.at).toBe(100);
    await fs.appendFile(rollout, output.slice(30) + "\n");
    const [a, b] = await Promise.all([reader.getSessionPrs(SESSION), reader.getSessionPrs(SESSION)]);
    expect(a).toEqual(b);
    expect(a[0]?.created).toBe(true);
    current = null;
    expect((await reader.getSessionPrs(SESSION))[0]).toMatchObject({ created: false, at: 100 });
  });
});
