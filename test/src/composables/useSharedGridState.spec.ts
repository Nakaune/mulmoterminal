import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import type { GridStateSnapshot } from "../../../common/gridStateSync";
import type { GridState } from "../../../src/components/gridTabs";

const pubsub = vi.hoisted(() => {
  const listeners = new Set<(value: unknown) => void>();
  const reconnects = new Set<() => void>();
  return { listeners, reconnects };
});

vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({
    subscribe: (_channel: string, callback: (value: unknown) => void) => {
      pubsub.listeners.add(callback);
      return () => pubsub.listeners.delete(callback);
    },
    onReconnect: (callback: () => void) => {
      pubsub.reconnects.add(callback);
      return () => pubsub.reconnects.delete(callback);
    },
  }),
}));

const { superseded } = await import("../../../src/composables/useActiveClient");
const { adoptSnapshot, sharedGridPayload, useSharedGridState } = await import("../../../src/composables/useSharedGridState");

const empty = (): GridState => ({ cells: [{ uid: 0, session: null, cwd: null }], expanded: null, page: 0, nextUid: 1, sortMode: "manual" });
const withSession = (id: string, cwd = "/work"): GridState => ({
  cells: [{ uid: 0, session: id, cwd }],
  expanded: null,
  page: 0,
  nextUid: 1,
  sortMode: "manual",
});

// A grid mid-launch: one running session, and the cell the user has the launcher open in —
// codex picked, directory chosen, no session id back from the server yet. The second cell is
// what the shared payload is not allowed to carry, which is the whole point of these tests.
const launching = (id: string): GridState => ({
  cells: [
    { uid: 0, session: id, cwd: "/work" },
    { uid: 1, session: null, cwd: "/work", agent: "codex" },
  ],
  expanded: 1,
  page: 0,
  nextUid: 2,
  sortMode: "manual",
});

let server: GridStateSnapshot;
let puts: unknown[];

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  superseded.value = false;
  pubsub.listeners.clear();
  pubsub.reconnects.clear();
  puts = [];
  server = { revision: 0, state: null, updatedBy: null };
  globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (!init || init.method !== "PUT") return { ok: true, status: 200, json: async () => server } as Response;
    const body = JSON.parse(String(init.body));
    puts.push(body);
    if (body.baseRevision !== server.revision) return { ok: false, status: 409, json: async () => server } as Response;
    server = { revision: server.revision + 1, state: body.state, updatedBy: body.clientId };
    return { ok: true, status: 200, json: async () => server } as Response;
  }) as typeof fetch;
});

afterEach(() => vi.useRealTimers());

const mountState = async (initial: GridState) => {
  const state = ref(initial);
  const wrapper = mount(
    defineComponent({
      setup: () => {
        useSharedGridState(state);
        return () => null;
      },
    }),
  );
  await flushPromises();
  return { state, wrapper };
};

describe("shared grid state", () => {
  it("a superseded tab neither writes nor adopts remote state", async () => {
    const local = withSession("11111111-1111-1111-1111-111111111111", "/local");
    const { state, wrapper } = await mountState(local);
    await vi.advanceTimersByTimeAsync(100);
    const putsBefore = puts.length;
    superseded.value = true;

    state.value = withSession("22222222-2222-2222-2222-222222222222", "/edited");
    await vi.advanceTimersByTimeAsync(200);
    expect(puts).toHaveLength(putsBefore);

    const pushed: GridStateSnapshot = { revision: 99, state: withSession("33333333-3333-3333-3333-333333333333", "/remote"), updatedBy: "other" };
    pubsub.listeners.forEach((callback) => callback(pushed));
    await nextTick();
    expect(state.value.cells[0]?.cwd).toBe("/edited");
    wrapper.unmount();
  });

  it("seeds an empty server from the existing localhost grid", async () => {
    const local = withSession("11111111-1111-1111-1111-111111111111");
    const { wrapper } = await mountState(local);
    await vi.advanceTimersByTimeAsync(100);

    expect(puts).toHaveLength(1);
    expect(server.state).toEqual(sharedGridPayload(local));
    wrapper.unmount();
  });

  it("does not let an empty remote browser erase the first-start migration", async () => {
    const { wrapper } = await mountState(empty());
    await vi.advanceTimersByTimeAsync(100);

    expect(puts).toHaveLength(0);
    expect(server.state).toBeNull();
    wrapper.unmount();
  });

  it("loads the server grid and applies a newer pubsub revision live", async () => {
    server = { revision: 3, state: withSession("33333333-3333-3333-3333-333333333333", "/local"), updatedBy: "other" };
    const { state, wrapper } = await mountState(empty());
    expect(state.value.cells[0]?.cwd).toBe("/local");

    const pushed: GridStateSnapshot = {
      revision: 4,
      state: withSession("44444444-4444-4444-4444-444444444444", "/remote"),
      updatedBy: "remote-tab",
    };
    pubsub.listeners.forEach((callback) => callback(pushed));
    await nextTick();

    expect(state.value.cells[0]?.session).toBe("44444444-4444-4444-4444-444444444444");
    expect(state.value.cells[0]?.cwd).toBe("/remote");
    wrapper.unmount();
  });

  it("accepts the other browser's state when its local write loses a revision race", async () => {
    const local = withSession("11111111-1111-1111-1111-111111111111", "/local");
    const { state, wrapper } = await mountState(local);
    server = { revision: 1, state: withSession("22222222-2222-2222-2222-222222222222", "/winner"), updatedBy: "other" };

    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(state.value.cells[0]?.cwd).toBe("/winner");
    expect(puts).toHaveLength(1);
    wrapper.unmount();
  });

  it("re-fetches state missed while the pubsub socket was disconnected", async () => {
    server = { revision: 1, state: withSession("11111111-1111-1111-1111-111111111111", "/before"), updatedBy: "other" };
    const { state, wrapper } = await mountState(empty());
    server = { revision: 2, state: withSession("22222222-2222-2222-2222-222222222222", "/after"), updatedBy: "other" };

    pubsub.reconnects.forEach((callback) => callback());
    await flushPromises();

    expect(state.value.cells[0]?.cwd).toBe("/after");
    wrapper.unmount();
  });

  it("does not share an ephemeral command or unfinished launch cell", () => {
    const value: GridState = {
      cells: [
        { uid: 0, session: "11111111-1111-1111-1111-111111111111", cwd: "/work" },
        { uid: 1, session: null, cwd: "/work", command: { source: "script", index: 0, label: "test", cwd: "/work" } },
        { uid: 2, session: null, cwd: null },
      ],
      expanded: null,
      page: 0,
      nextUid: 3,
      sortMode: "manual",
    };

    expect(sharedGridPayload(value).cells).toEqual([{ uid: 0, session: "11111111-1111-1111-1111-111111111111", cwd: "/work", launcher: null }]);
  });

  // The bug this pair exists for: the other browser writes while this one is starting a session,
  // and the cell being launched into — which the payload deliberately cannot carry — is deleted by
  // the snapshot. The user picked codex in a fresh cell and got the snapshot's zoomed cell instead,
  // an existing claude session, with no sign that anything had been replaced.
  it("keeps the cell being launched into when the other browser's snapshot arrives", async () => {
    const { state, wrapper } = await mountState(launching("11111111-1111-1111-1111-111111111111"));

    pubsub.listeners.forEach((callback) =>
      callback({ revision: 9, state: withSession("22222222-2222-2222-2222-222222222222", "/other"), updatedBy: "other-tab" } satisfies GridStateSnapshot),
    );
    await nextTick();

    expect(state.value.cells.some((cell) => cell.session === null && cell.agent === "codex")).toBe(true);
    wrapper.unmount();
  });

  it("leaves the view on that cell rather than on the snapshot's", async () => {
    const { state, wrapper } = await mountState(launching("11111111-1111-1111-1111-111111111111"));

    pubsub.listeners.forEach((callback) =>
      callback({ revision: 9, state: withSession("22222222-2222-2222-2222-222222222222", "/other"), updatedBy: "other-tab" } satisfies GridStateSnapshot),
    );
    await nextTick();

    const zoomed = state.value.cells.find((cell) => cell.uid === state.value.expanded);
    expect(zoomed?.session).toBeNull();
    wrapper.unmount();
  });
});

// The uid is what each browser's mounted cell is keyed by. A payload or snapshot that renumbered
// them handed every live terminal a different cell's session (2026-10-01: a move in one browser
// cloned sessions over one another in the other and lost one).
describe("uids on the wire", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const sparse: GridState = {
    cells: [
      { uid: 3, session: A, cwd: "/a" },
      { uid: 7, session: B, cwd: "/b" },
      { uid: 8, session: null, cwd: null },
    ],
    expanded: 7,
    page: 0,
    nextUid: 9,
    sortMode: "manual",
  };

  it("keeps each cell's uid and the zoomed uid in the shared payload", () => {
    const payload = sharedGridPayload(sparse);
    expect(payload.cells.map((cell) => cell.uid)).toEqual([3, 7]);
    expect(payload.expanded).toBe(7);
    expect(payload.nextUid).toBe(9);
  });

  it("applies another browser's reorder without changing any uid", async () => {
    server = { revision: 1, state: sharedGridPayload(sparse), updatedBy: "other-tab" };
    const { state, wrapper } = await mountState(sparse);

    const [first, second] = sparse.cells;
    if (!first || !second) throw new Error("fixture has two running cells");
    const moved: GridState = { ...sparse, cells: [second, first] };
    server = { revision: 2, state: sharedGridPayload(moved), updatedBy: "other-tab" };
    pubsub.listeners.forEach((callback) => callback(server));
    await nextTick();

    expect(state.value.cells.map((cell) => [cell.uid, cell.session])).toEqual([
      [7, B],
      [3, A],
      [8, null],
    ]);
    expect(state.value.expanded).toBe(7);
    wrapper.unmount();
  });

  it("gives a cell added by the other browser its own uid, not this browser's next one", async () => {
    server = { revision: 1, state: sharedGridPayload(sparse), updatedBy: "other-tab" };
    const { state, wrapper } = await mountState(sparse);

    const added: GridState = { ...sparse, cells: [...sparse.cells.slice(0, 2), { uid: 12, session: C, cwd: "/c" }], nextUid: 13 };
    server = { revision: 2, state: sharedGridPayload(added), updatedBy: "other-tab" };
    pubsub.listeners.forEach((callback) => callback(server));
    await nextTick();

    expect(state.value.cells.map((cell) => cell.uid)).toEqual([3, 7, 12, 8]);
    expect(state.value.nextUid).toBe(13);
    wrapper.unmount();
  });
});

// The merge rule on its own. The sync class decides WHEN to adopt; this decides what adopting costs.
describe("adoptSnapshot", () => {
  const incoming: GridState = {
    cells: [{ uid: 0, session: "22222222-2222-2222-2222-222222222222", cwd: "/other" }],
    expanded: 0,
    page: 0,
    nextUid: 1,
    sortMode: "manual",
  };

  it("takes the snapshot whole when nothing here is launching", () => {
    expect(adoptSnapshot(withSession("11111111-1111-1111-1111-111111111111"), incoming)).toBe(incoming);
  });

  it("carries a launch cell across, after the snapshot's own", () => {
    const merged = adoptSnapshot(launching("11111111-1111-1111-1111-111111111111"), incoming);
    expect(merged.cells.map((cell) => cell.session)).toEqual(["22222222-2222-2222-2222-222222222222", null]);
  });

  it("keeps the launch cell's uid when the snapshot has not claimed it", () => {
    // The grid keys cells by uid: a new uid remounts the cell, which drops the connection the
    // launch is in the middle of opening. Renumbering is for a real collision only.
    const merged = adoptSnapshot(launching("11111111-1111-1111-1111-111111111111"), incoming);
    expect(merged.cells[1]?.uid).toBe(1);
    expect(merged.nextUid).toBe(2);
  });

  it("renumbers only when the snapshot already uses that uid", () => {
    const collides: GridState = { ...incoming, cells: [{ uid: 1, session: "22222222-2222-2222-2222-222222222222", cwd: "/other" }], expanded: 1, nextUid: 2 };
    const merged = adoptSnapshot(launching("11111111-1111-1111-1111-111111111111"), collides);
    expect(merged.cells[1]?.uid).toBe(2);
    expect(merged.nextUid).toBe(3);
    expect(merged.expanded).toBe(2); // the zoom follows the cell, not the old number
  });

  it("keeps the snapshot's zoom when the user was not looking at a launch cell", () => {
    const elsewhere: GridState = { ...launching("11111111-1111-1111-1111-111111111111"), expanded: 0 };
    expect(adoptSnapshot(elsewhere, incoming).expanded).toBe(0);
  });

  it("does not carry cells past the grid's limit", () => {
    const full: GridState = {
      cells: Array.from({ length: 81 }, (_, i) => ({ uid: i, session: `${i}`.padStart(8, "0") + "-0000-0000-0000-000000000000", cwd: null })),
      expanded: null,
      page: 0,
      nextUid: 81,
      sortMode: "manual",
    };
    expect(adoptSnapshot(launching("11111111-1111-1111-1111-111111111111"), full).cells).toHaveLength(81);
  });
});

// The window the launch-cell carry-over above does not reach. The server answers the launch with an
// id, the cell now HAS a session, and this browser's save of it is still in its debounce — or loses
// the revision race — when the other browser's snapshot lands. The cell is no longer "launching",
// so nothing carried it: the snapshot deleted the brand-new session's cell, the view fell back to
// the snapshot's zoom (the user's previous session), and the orphaned session exited on its own.
describe("edits not yet written survive another browser's snapshot", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const grid = (...ids: string[]): GridState => ({
    cells: ids.map((session, uid) => ({ uid, session, cwd: "/work" })),
    expanded: null,
    page: 0,
    nextUid: ids.length,
    sortMode: "manual",
  });
  const sessions = (state: GridState | unknown) => (state as GridState).cells.map((cell) => cell.session);

  // Synced with the server at revision 1 holding [A], then the launch in this browser resolves to X.
  const launchedLocally = async () => {
    server = { revision: 1, state: grid(A), updatedBy: "other-tab" };
    const mounted = await mountState(grid(A));
    mounted.state.value = { ...mounted.state.value, cells: [...mounted.state.value.cells, { uid: 1, session: X, cwd: "/work" }], nextUid: 2, expanded: 1 };
    await nextTick();
    return mounted;
  };

  it("keeps the new session when a pubsub snapshot lands before the save", async () => {
    const { state, wrapper } = await launchedLocally();

    server = { revision: 2, state: grid(A, B), updatedBy: "other-tab" };
    pubsub.listeners.forEach((callback) => callback(server));
    await nextTick();

    expect(sessions(state.value)).toEqual([A, B, X]);
    expect(state.value.cells.find((cell) => cell.uid === state.value.expanded)?.session).toBe(X);
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(sessions(server.state)).toEqual([A, B, X]);
    wrapper.unmount();
  });

  it("keeps the new session when its save loses the revision race", async () => {
    const { state, wrapper } = await launchedLocally();

    server = { revision: 2, state: grid(A, B), updatedBy: "other-tab" }; // written, not yet published
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(sessions(state.value)).toEqual([A, B, X]);
    expect(sessions(server.state)).toEqual([A, B, X]);
    wrapper.unmount();
  });

  it("does not bring back a cell closed here that the snapshot still lists", async () => {
    server = { revision: 1, state: grid(A, B), updatedBy: "other-tab" };
    const { state, wrapper } = await mountState(grid(A, B));
    state.value = { ...state.value, cells: state.value.cells.filter((cell) => cell.session !== B) };
    await nextTick();

    server = { revision: 2, state: { ...grid(A, B, X) }, updatedBy: "other-tab" };
    pubsub.listeners.forEach((callback) => callback(server));
    await nextTick();

    expect(sessions(state.value)).toEqual([A, X]);
    wrapper.unmount();
  });

  it("still lets the other browser close a cell this one did not touch", async () => {
    server = { revision: 1, state: grid(A, B), updatedBy: "other-tab" };
    const { state, wrapper } = await mountState(grid(A, B));

    server = { revision: 2, state: grid(A), updatedBy: "other-tab" };
    pubsub.listeners.forEach((callback) => callback(server));
    await nextTick();

    expect(sessions(state.value)).toEqual([A]);
    wrapper.unmount();
  });
});
