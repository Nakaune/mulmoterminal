import { beforeEach, describe, expect, it, vi } from "vitest";

const pubsub = vi.hoisted(() => ({ listeners: new Set<(v: unknown) => void>(), reconnects: new Set<() => void>() }));
const freezeAll = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());

vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({
    subscribe: (_c: string, cb: (v: unknown) => void) => {
      pubsub.listeners.add(cb);
      return () => pubsub.listeners.delete(cb);
    },
    onReconnect: (cb: () => void) => {
      pubsub.reconnects.add(cb);
      return () => pubsub.reconnects.delete(cb);
    },
  }),
}));
vi.mock("../../../src/composables/useTerminalConnections", () => ({ freezeAll }));
vi.mock("../../../src/composables/useUnloadGuard", () => ({ reportActiveTerminals: report }));

const { superseded, useActiveClient } = await import("../../../src/composables/useActiveClient");
const { syncClientId } = await import("../../../src/composables/syncClientId");

let serverId: string | null;
let posts: string[];

const publish = (clientId: string | null) => pubsub.listeners.forEach((cb) => cb({ clientId }));
const reconnect = async () => {
  pubsub.reconnects.forEach((cb) => cb());
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  sessionStorage.clear();
  pubsub.listeners.clear();
  pubsub.reconnects.clear();
  freezeAll.mockClear();
  report.mockClear();
  superseded.value = false;
  serverId = null;
  posts = [];
  globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const { clientId } = JSON.parse(String(init.body));
      posts.push(clientId);
      serverId = clientId;
    }
    return { ok: true, status: 200, json: async () => ({ clientId: serverId }) } as Response;
  }) as typeof fetch;
});

describe("useActiveClient", () => {
  it("claims on start with the tab's grid sync id", async () => {
    useActiveClient();
    await Promise.resolve();
    expect(posts).toEqual([syncClientId()]);
    expect(superseded.value).toBe(false);
  });

  it("is superseded when another id is published, freezing terminals", () => {
    useActiveClient();
    publish("someone-else");
    expect(superseded.value).toBe(true);
    expect(freezeAll).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("grid", 0);
  });

  it("ignores its own id", () => {
    useActiveClient();
    publish(syncClientId());
    publish(null);
    expect(superseded.value).toBe(false);
    expect(freezeAll).not.toHaveBeenCalled();
  });

  it("re-claims on reconnect when the server forgot and this tab is active", async () => {
    useActiveClient();
    await Promise.resolve();
    serverId = null;
    posts.length = 0;
    await reconnect();
    expect(posts).toEqual([syncClientId()]);
  });

  it("never re-claims once superseded", async () => {
    useActiveClient();
    await Promise.resolve();
    publish("someone-else");
    serverId = null;
    posts.length = 0;
    await reconnect();
    expect(posts).toEqual([]);
    expect(superseded.value).toBe(true);
  });

  it("becomes superseded on reconnect when the server names another id", async () => {
    useActiveClient();
    await Promise.resolve();
    serverId = "someone-else";
    await reconnect();
    expect(superseded.value).toBe(true);
    expect(freezeAll).toHaveBeenCalledTimes(1);
  });
});
