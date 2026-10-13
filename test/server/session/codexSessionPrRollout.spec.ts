// @vitest-environment node
import { describe, it, expect } from "vitest";
import { codexPrsFromRollout, emptyCodexPrScan, foldCodexPrRecord } from "../../../server/session/codex-session-pr.js";

// Shapes copied from a real rollout: the command and its output are two records joined by
// `call_id`, and the stamp Codex writes beside each is in SECONDS.
const call = (callId: string, cmd: string) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: callId,
      name: "exec",
      input: `const r = await tools.exec_command({cmd: ${JSON.stringify(cmd)}, workdir: "/w"}); text(r.output);`,
      internal_chat_message_metadata_passthrough: { create_time: 1_700_000_000 },
    },
  });

const output = (callId: string, text: string, createTime = 1_700_000_010) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [
        { type: "input_text", text: "Script completed\nWall time 1.3 seconds\nOutput:\n" },
        { type: "input_text", text },
      ],
      internal_chat_message_metadata_passthrough: { create_time: createTime },
    },
  });

const PR_1357 = "https://github.com/Nakaune/AidaNote/pull/1357\n";

describe("codexPrsFromRollout", () => {
  it("pairs a command with its output and reports what it did", () => {
    const prs = codexPrsFromRollout([call("c1", "gh pr create --draft --fill"), output("c1", PR_1357)], 0);
    expect(prs).toEqual([
      { number: 1357, url: "https://github.com/Nakaune/AidaNote/pull/1357", repo: "Nakaune/AidaNote", created: true, at: 1_700_000_010_000 },
    ]);
  });

  // The command is on the CALL. A tail that begins after it leaves an output nobody can judge —
  // and judging it anyway is how `gh pr list` output would be read as work the session did.
  it("skips an output whose call fell off the front of the tail", () => {
    expect(codexPrsFromRollout([output("c1", PR_1357)], 0)).toEqual([]);
  });

  it("keeps one entry per request, stamped with the LAST act", () => {
    const prs = codexPrsFromRollout(
      [
        call("c1", "gh pr create --fill"),
        output("c1", PR_1357, 1_700_000_010),
        call("c2", "gh pr edit 1357 --add-label x"),
        output("c2", PR_1357, 1_700_000_900),
      ],
      0,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]?.at).toBe(1_700_000_900_000);
    // Opened by this session, so it stays "created" even after a later edit.
    expect(prs[0]?.created).toBe(true);
  });

  it("falls back to the caller's stamp when the record carries none", () => {
    const bare = JSON.stringify({ payload: { type: "custom_tool_call_output", call_id: "c1", output: PR_1357 } });
    expect(codexPrsFromRollout([call("c1", "gh pr create --fill"), bare], 4242)?.[0]?.at).toBe(4242);
  });

  // The file is appended to while it is read, so the last line can be half-written.
  it("survives a truncated line and lines that are not calls at all", () => {
    const prs = codexPrsFromRollout(
      [
        '{"type":"event_msg","payload":{"type":"token_count"}}',
        call("c1", "gh pr create --fill"),
        output("c1", PR_1357),
        '{"payload":{"type":"custom_tool_call',
      ],
      0,
    );
    expect(prs).toHaveLength(1);
  });

  it("reports nothing for a session that only read", () => {
    expect(codexPrsFromRollout([call("c1", "gh pr list --json url"), output("c1", PR_1357)], 0)).toEqual([]);
  });
  it("uses the record timestamp and releases unmatched non-PR programs", () => {
    const scan = emptyCodexPrScan();
    for (let i = 0; i < 1000; i++)
      foldCodexPrRecord(scan, { callId: String(i), payload: { type: "custom_tool_call", input: 'text(await tools.exec_command({cmd: "git status"}))' } }, 0);
    expect(scan.inputById.size).toBe(0);
    const output = JSON.stringify({ timestamp: "2026-09-22T00:00:00Z", payload: { type: "custom_tool_call_output", call_id: "c", output: PR_1357 } });
    expect(codexPrsFromRollout([call("c", "gh pr create --fill"), output], 0)[0]?.at).toBe(Date.parse("2026-09-22T00:00:00Z"));
  });
});
