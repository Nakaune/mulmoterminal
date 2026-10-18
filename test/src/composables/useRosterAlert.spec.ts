import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// The composable holds module-level state seeded from localStorage at import time, so each case
// re-imports it with the storage it wants. resetModules is what makes the seeding observable.
const load = async () => {
  vi.resetModules();
  return (await import("../../../src/composables/useRosterAlert")).useRosterAlert();
};

describe("useRosterAlert", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  // Default OFF (#1131 の既定を反転): the waiting row already carries an amber edge and wash, so
  // the motion is the part that is worth asking for rather than the part worth imposing. Someone
  // who has never opened Settings gets the colour and no movement.
  it("does not blink by default — the row is still marked, just still", async () => {
    const { blink } = await load();
    expect(blink.value).toBe(false);
  });

  it("remembers being turned off", async () => {
    const { setBlink } = await load();
    setBlink(false);
    expect(localStorage.getItem("rosterAlertBlink")).toBe("off");
    const { blink } = await load();
    expect(blink.value).toBe(false);
  });

  // The RELOAD is the point, not the write. With the default off, a reader that only knows how to
  // recognise "off" hands back the default for every other value — including the "on" it just
  // wrote — so turning the motion on would last exactly one page. Asserting the stored string
  // alone cannot see that.
  it("comes back on, and survives a reload", async () => {
    localStorage.setItem("rosterAlertBlink", "off");
    const { blink, setBlink } = await load();
    expect(blink.value).toBe(false);
    setBlink(true);
    expect(blink.value).toBe(true);
    expect(localStorage.getItem("rosterAlertBlink")).toBe("on");
    expect((await load()).blink.value).toBe(true);
  });

  // Only the explicit "on" is on. Anything else is someone who never chose, and the default is
  // what they should get — not motion switched on by a value we cannot read.
  it("treats a blank or unrecognised stored value as the default", async () => {
    for (const stored of ["", "  ", "true", "1", "nope"]) {
      localStorage.setItem("rosterAlertBlink", stored);
      const { blink } = await load();
      expect(blink.value).toBe(false);
    }
  });

  // Private mode and storage-blocked contexts throw on access. The setting is a preference, not
  // state the app needs, so it degrades to "applies this session" rather than breaking the grid.
  it("survives storage that throws, in both directions", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { blink, setBlink } = await load();
    expect(blink.value).toBe(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setBlink(true)).not.toThrow();
    expect(blink.value).toBe(true);
  });
});
