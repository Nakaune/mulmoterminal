import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same doubles as the sibling connection specs (test/helpers/xtermDouble.ts); see the note there
// about why the mock factories import themselves.
const { termState: mockTermState, keyState: mockKeyState } = await vi.hoisted(async () => (await import("../../helpers/xtermDouble")).createXtermState());

vi.mock("@xterm/xterm", async () => (await import("../../helpers/xtermDouble")).xtermModule(mockTermState, mockKeyState));
vi.mock("@xterm/addon-fit", async () => (await import("../../helpers/xtermDouble")).fitAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../../helpers/xtermDouble")).webLinksAddonModule());
vi.mock("@xterm/addon-clipboard", async () => (await import("../../helpers/xtermDouble")).clipboardAddonModule());
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import * as conn from "../../../src/composables/useTerminalConnections";
import { FakeWebSocket } from "../../helpers/xtermDouble";

// Whether a slot is attached is not cosmetic bookkeeping: `fit` reads it, and a slot it reads as
// detached stops re-fitting, stops sending the pty a size and stops repainting — so the pty freezes
// at the size it last heard while the browser draws the cell at a new one (#1178).
const KEY = "cell-attach";
const target = { sessionId: null, cwd: "/w", devTerminal: false, command: null, launcher: null };
const resizeFrames = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "resize");

describe("slot attachment", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => conn.release(KEY));

  // The ordering this exists for: a view that mounts before the previous one has finished
  // unmounting. The old view's detach names the element IT attached, so the guard can tell that a
  // newer view owns the slot — passing null (which is what a template ref reads as inside
  // `unmounted`) made every such detach unconditional.
  it("does not let a replaced view's detach take the slot from the live one", () => {
    const old = document.createElement("div");
    const live = document.createElement("div");
    conn.attach(KEY, target, {}, old);
    conn.attach(KEY, target, {}, live);

    conn.detach(KEY, old);

    expect(live.childElementCount).toBe(1); // the terminal is still on screen where it was moved
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no socket created");
    ws.sent.length = 0;
    conn.fit(KEY);
    expect(resizeFrames(ws)).toHaveLength(1); // …and still tells the pty its size
  });

  it("still tears the view down when the element that attached it is the one leaving", () => {
    const el = document.createElement("div");
    conn.attach(KEY, target, {}, el);
    conn.detach(KEY, el);
    expect(el.childElementCount).toBe(0);
  });

  // The shared grid can hand this uid to another session (another browser renumbered or reused
  // it). Reusing the slot would replay the OLD id and write it back over the new cell.
  it("drops a slot that still holds a different session than the cell now asks for", () => {
    const first = document.createElement("div");
    conn.attach(KEY, { ...target, sessionId: "11111111-1111-4111-8111-111111111111" }, {}, first);
    const oldWs = FakeWebSocket.instances.at(-1);
    conn.detach(KEY, first);

    const seen: string[] = [];
    const next = document.createElement("div");
    conn.attach(KEY, { ...target, sessionId: "22222222-2222-4222-8222-222222222222" }, { onSession: (id) => seen.push(id) }, next);

    expect(seen).not.toContain("11111111-1111-4111-8111-111111111111");
    const newWs = FakeWebSocket.instances.at(-1);
    expect(newWs).not.toBe(oldWs);
    expect(newWs?.url).toContain("session=22222222-2222-4222-8222-222222222222");
  });

  it("keeps a slot whose session id arrived while detached (the cell still says null)", () => {
    const first = document.createElement("div");
    conn.attach(KEY, { ...target, sessionId: "33333333-3333-4333-8333-333333333333" }, {}, first);
    const ws = FakeWebSocket.instances.at(-1);
    conn.detach(KEY, first);

    const seen: string[] = [];
    conn.attach(KEY, target, { onSession: (id) => seen.push(id) }, document.createElement("div"));

    expect(seen).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(FakeWebSocket.instances.at(-1)).toBe(ws);
  });

  // The safety net under the rule above: whatever the bookkeeping says, a terminal whose host is
  // still in the document is attached, and must not be left in a state where nothing ever fits or
  // repaints it again.
  it("re-adopts a slot whose attachment was lost while its terminal is still on screen", () => {
    const el = document.createElement("div");
    document.body.appendChild(el); // on screen is the condition — a detached container is not it
    conn.attach(KEY, target, {}, el);
    const host = el.firstElementChild;
    if (!host) throw new Error("no host attached");

    conn.detach(KEY, null); // bookkeeping cleared…
    el.appendChild(host); // …but the terminal is on screen

    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no socket created");
    ws.sent.length = 0;
    conn.fit(KEY);
    expect(resizeFrames(ws)).toHaveLength(1);
    el.remove();
  });

  // The other half of that rule: a container that has left the document is not somewhere the
  // terminal can be measured, so the slot stays detached rather than pointing at an orphan.
  it("does not adopt a host whose container has left the document", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    conn.attach(KEY, target, {}, el);
    const host = el.firstElementChild;
    if (!host) throw new Error("no host attached");

    conn.detach(KEY, null);
    el.appendChild(host);
    el.remove(); // the whole cell went away with its terminal inside it

    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no socket created");
    ws.sent.length = 0;
    conn.fit(KEY);
    expect(resizeFrames(ws)).toEqual([]);
  });
});
