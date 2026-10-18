import { beforeEach, describe, expect, it, vi } from "vitest";

const { termState: mockTermState, keyState: mockKeyState } = await vi.hoisted(async () => (await import("../../helpers/xtermDouble")).createXtermState());

vi.mock("@xterm/xterm", async () => (await import("../../helpers/xtermDouble")).xtermModule(mockTermState, mockKeyState));
vi.mock("@xterm/addon-fit", async () => (await import("../../helpers/xtermDouble")).fitAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../../helpers/xtermDouble")).webLinksAddonModule());
vi.mock("@xterm/addon-clipboard", async () => (await import("../../helpers/xtermDouble")).clipboardAddonModule());
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import * as conn from "../../../src/composables/useTerminalConnections";
import { FakeWebSocket } from "../../helpers/xtermDouble";

const target = { sessionId: null, cwd: "/w", devTerminal: false, command: null, launcher: null };

describe("freezeAll", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  // Closing would detach every session, and an idle detached one is reaped after the short grace
  // unless the newer tab attaches it in time.
  it("keeps every socket open, without sending terminate", () => {
    conn.attach("fa-a", target, {}, document.createElement("div"));
    conn.attach("fa-b", target, {}, document.createElement("div"));
    expect(FakeWebSocket.instances).toHaveLength(2);

    conn.freezeAll();

    for (const ws of FakeWebSocket.instances) {
      expect(ws.readyState).toBe(FakeWebSocket.OPEN);
      expect(ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "terminate")).toEqual([]);
    }
  });

  // A reconnect from the inert tab would take the viewer back from the tab now in use.
  it("does not reconnect a frozen slot when its socket drops", () => {
    vi.useFakeTimers();
    try {
      conn.attach("fa-c", target, {}, document.createElement("div"));
      const before = FakeWebSocket.instances.length;
      conn.freezeAll();
      FakeWebSocket.instances[before - 1].onclose?.();
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
