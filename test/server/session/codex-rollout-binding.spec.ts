// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyEntry } from "../../../server/session/types.js";
import type { SpawnDeps } from "../../../server/session/spawn-deps.js";
import type { RolloutMeta } from "../../../server/agents/codex-session.js";

const state = vi.hoisted(() => ({
  ptys: new Map<string, PtyEntry>(),
  mappings: new Map<string, { conversationId: string }>(),
  titles: new Map<string, string>(),
  live: null as RolloutMeta | null,
  track: vi.fn(),
  publish: vi.fn(),
  remember: vi.fn(),
}));
vi.mock("../../../server/session/registry.js", () => ({
  ptys: state.ptys,
  codexRollouts: state.mappings,
  codexRolloutsHydrated: Promise.resolve(),
  claimedCodexRollouts: new Set(),
  aiTitles: state.titles,
  lastPrompts: new Map(),
  lastResponses: new Map(),
  lastTitledUserTurns: new Map(),
  lastTitleAttemptMs: new Map(),
  titleEpoch: new Map(),
  rememberCodexRollout: (id: string, conversationId: string, cwd: string) => {
    state.mappings.set(id, { conversationId });
    state.remember(id, conversationId, cwd);
  },
}));
vi.mock("../../../server/agents/codex-live-rollout.js", () => ({ liveCodexRollout: () => state.live }));
vi.mock("../../../server/infra/tmux.js", () => ({ tmuxPanePid: () => 10 }));
vi.mock("../../../server/session/codex-legacy-rollout.js", () => ({ readLegacyCodexRolloutId: () => null }));
vi.mock("../../../server/agents/codex-sessions.js", () => ({ codexRolloutPath: (_root: string, id: string) => `/rollout/${id}` }));
vi.mock("../../../server/agents/codex-session.js", () => ({
  readSessionMeta: (file: string) => ({ id: file.split("/").pop(), cwd: "/same" }),
  watchForCodexSession: vi.fn(),
}));
vi.mock("../../../server/session/codex-activity-track.js", () => ({ trackCodexActivity: state.track }));
import { bindCodexRollout } from "../../../server/session/codex-rollout-binding.js";

const meta = (id: string): RolloutMeta => ({ id, file: `/rollout/${id}`, cwd: "/actual" });
const entry = () => ({ term: { pid: 10 }, tmux: true, active: false, cwd: "/browser" }) as unknown as PtyEntry;
const deps = { setWorking: vi.fn(), setWaiting: vi.fn(), uiPort: "0", publishActivity: state.publish } as unknown as SpawnDeps;
const start = (pty: PtyEntry, resume: string | null = null) => {
  state.ptys.set("cell", pty);
  return bindCodexRollout({ id: "cell", entry: pty, root: "/sessions", before: new Set(), reattached: true, resume }, deps);
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.ptys.clear();
  state.mappings.clear();
  state.titles.clear();
  state.live = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(process.platform !== "linux")("live binding across restart", () => {
  it("recovers absent/stale mappings and ignores a stale browser resume id", async () => {
    state.mappings.set("cell", { conversationId: "stale" });
    state.titles.set("cell", "old title");
    state.live = meta("actual");
    const first = start(entry(), "wrong-browser");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.remember).toHaveBeenCalledWith("cell", "actual", "/actual");
    expect(state.titles.has("cell")).toBe(false);
    expect(state.track.mock.calls[0]?.[1]).toBe("/rollout/actual");
    state.ptys.clear();
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    // A new server process with no persisted map still resolves the surviving writer.
    state.mappings.clear();
    const second = start(entry());
    await vi.advanceTimersByTimeAsync(0);
    expect(state.mappings.get("cell")?.conversationId).toBe("actual");
    state.ptys.clear();
    await vi.advanceTimersByTimeAsync(5000);
    await second;
  });

  it("waits for the first rollout and stops the old activity tail on in-place resume", async () => {
    const running = start(entry());
    await vi.advanceTimersByTimeAsync(0);
    expect(state.track).not.toHaveBeenCalled();
    state.live = meta("first");
    await vi.advanceTimersByTimeAsync(1000);
    const oldTail = state.track.mock.calls[0]?.[3] as { isAlive: () => boolean };
    expect(oldTail.isAlive()).toBe(true);
    state.live = meta("next");
    await vi.advanceTimersByTimeAsync(5000);
    expect(oldTail.isAlive()).toBe(false);
    expect(state.mappings.get("cell")?.conversationId).toBe("next");
    state.ptys.set("cell", entry());
    await vi.advanceTimersByTimeAsync(5000);
    await running;
    expect(state.track).toHaveBeenCalledTimes(2);
  });
  it("does not activate a stale persisted mapping while the surviving process has no writer yet", async () => {
    state.mappings.set("cell", { conversationId: "stale" });
    const running = start(entry(), "browser-stale");
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.track).not.toHaveBeenCalled();
    expect(state.remember).not.toHaveBeenCalled();
    state.live = meta("actual");
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.remember).toHaveBeenCalledExactlyOnceWith("cell", "actual", "/actual");
    state.ptys.clear();
    await vi.advanceTimersByTimeAsync(5000);
    await running;
  });
});
