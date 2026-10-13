import { describe, it, expect } from "vitest";
import { liveSessionRows, type LiveSessionLookup } from "./live-sessions";
import type { SessionAgent } from "../../common/sessionAgent";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const WORKER = "33333333-3333-3333-3333-333333333333";

const lookup = (over: Partial<LiveSessionLookup> = {}): LiveSessionLookup => ({
  agent: () => "claude",
  cwd: () => null,
  excluded: () => false,
  ...over,
});
const agents = (map: Record<string, SessionAgent | null>) => (id: string) => map[id] ?? null;

describe("liveSessionRows", () => {
  it("reports what a cell needs to adopt the session", () => {
    const rows = liveSessionRows([A], lookup({ cwd: () => "/proj", agent: () => "codex" }));
    expect(rows).toEqual([{ id: A, agent: "codex", cwd: "/proj" }]);
  });

  // The agent decides which endpoint a cell reconnects on: a codex session adopted as claude
  // attaches to the wrong one (PR #1189).
  it("keeps each session's own agent", () => {
    const rows = liveSessionRows([A, B], lookup({ agent: agents({ [A]: "claude", [B]: "codex" }) }));
    expect(rows.map((r) => r.agent)).toEqual(["claude", "codex"]);
  });

  // A phone's list is short and the point is to find the session you were working in; workers and
  // the hidden rate-limit probe would bury it.
  it("drops the sessions the caller excludes", () => {
    const rows = liveSessionRows([A, WORKER], lookup({ excluded: (id) => id === WORKER }));
    expect(rows.map((r) => r.id)).toEqual([A]);
  });

  // The two cases are a plain shell and a session nothing recorded, and neither is a conversation:
  // the grid cannot hold a shell as an agent cell, and adopting one as Claude would offer to
  // resume a shell as a chat.
  it.each([
    ["a plain shell", "shell" as SessionAgent],
    ["a session nothing can name", null],
  ])("drops %s rather than defaulting it to claude", (_case, agent) => {
    expect(liveSessionRows([A], lookup({ agent: () => agent }))).toEqual([]);
  });

  // The ids arrive as a union of two sources (this process's PTYs and tmux), so the same session
  // is in both whenever a browser is attached — which is the normal case, not an edge one.
  it("reports a session once even when both sources name it", () => {
    expect(liveSessionRows([A, A, B], lookup()).map((r) => r.id)).toEqual([A, B]);
  });

  // Nothing recorded a directory for a session that outlived the record. Null, not a guess: the
  // client falls back to its own default, and inventing one puts the cell in the wrong place.
  it("reports a null directory rather than inventing one", () => {
    expect(liveSessionRows([A], lookup())[0].cwd).toBeNull();
  });

  it("says nothing when nothing is running", () => {
    expect(liveSessionRows([], lookup())).toEqual([]);
  });
});
