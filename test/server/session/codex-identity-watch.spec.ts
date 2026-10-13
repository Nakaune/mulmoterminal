// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { watchCodexIdentity } from "../../../server/session/codex-identity-watch.js";
import type { RolloutMeta } from "../../../server/agents/codex-session.js";

const meta = (id: string): RolloutMeta => ({ id, file: `/sessions/${id}.jsonl`, cwd: "/same" });

describe("watchCodexIdentity", () => {
  it("recovers a missing mapping, corrects a stale mapping, and detects in-place resume", async () => {
    const a = meta("a");
    const b = meta("b");
    const rows = [a, null, a, b];
    let index = 0;
    const changed = vi.fn();
    await watchCodexIdentity({
      readLive: () => rows[index] ?? null,
      isAlive: () => index < rows.length,
      onChange: changed,
      sleep: async () => {
        index++;
      },
    });
    expect(changed.mock.calls.map(([value]) => (value as RolloutMeta).id)).toEqual(["a", "b"]);
  });
  it("waits for a delayed first turn and stops when its own pty is replaced", async () => {
    let polls = 0;
    const changed = vi.fn();
    await watchCodexIdentity({
      readLive: () => (polls === 3 ? meta("late") : null),
      isAlive: () => polls < 5,
      onChange: changed,
      sleep: async () => {
        polls++;
      },
    });
    expect(changed).toHaveBeenCalledExactlyOnceWith(meta("late"));
  });
  it("does not publish if the pty is replaced during inspection", async () => {
    let alive = true;
    const changed = vi.fn();
    await watchCodexIdentity({
      readLive: () => {
        alive = false;
        return meta("other");
      },
      isAlive: () => alive,
      onChange: changed,
      sleep: async () => {},
    });
    expect(changed).not.toHaveBeenCalled();
  });
});
