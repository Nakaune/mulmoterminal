import { describe, it, expect } from "vitest";
import { isPhoneLayout, layoutOverrideFrom, PHONE_MAX_WIDTH_PX } from "../../../src/composables/phoneLayout";

// The rule is a WIDTH, and these pin what that buys: a narrow desktop window gets the phone
// layout (it has the same problem), and a phone in landscape gets the desktop one back (it no
// longer has it). A user-agent test could express neither.
describe("isPhoneLayout", () => {
  it.each([
    ["an iPhone portrait", 390, true],
    ["a small Android", 360, true],
    ["exactly the threshold", PHONE_MAX_WIDTH_PX, true],
    ["one pixel past it", PHONE_MAX_WIDTH_PX + 1, false],
    ["a phone turned landscape", 844, false],
    ["a laptop", 1440, false],
    ["a half-width desktop window", 640, true],
  ])("%s", (_case, width, expected) => {
    expect(isPhoneLayout(width, null)).toBe(expected);
  });

  // The escape hatch outranks the measurement in BOTH directions — one to see the phone layout
  // from a desktop while building it, one to get the desktop back on a device that cannot be
  // made wider.
  it("obeys an override against the width", () => {
    expect(isPhoneLayout(1440, "phone")).toBe(true);
    expect(isPhoneLayout(390, "desktop")).toBe(false);
  });
});

describe("layoutOverrideFrom", () => {
  it.each([
    ["?layout=phone", "phone"],
    ["?layout=desktop", "desktop"],
    ["?other=1&layout=phone", "phone"],
  ])("reads %s", (search, expected) => {
    expect(layoutOverrideFrom(search)).toBe(expected);
  });

  // A typo is no opinion rather than a third layout: `?layout=mobile` should measure the window,
  // not pin whichever branch the unrecognised string happened to fall into.
  it.each(["", "?layout=", "?layout=mobile", "?layout=PHONE", "?nothing=1"])("has no opinion about %o", (search) => {
    expect(layoutOverrideFrom(search)).toBeNull();
  });
});
