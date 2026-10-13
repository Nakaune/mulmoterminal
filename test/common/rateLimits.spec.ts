import { describe, it, expect } from "vitest";
import { parseRateLimits, parseRateLimitWindow, parseScopedRateLimitWindow } from "../../common/rateLimits";

// The wire parser both sides run (#387). Its guards were hand-copied one-liners until #1074 moved
// them to common/isRecord.ts and common/finiteNumber.ts — the shared `isRecord` REJECTS arrays
// where the copy accepted them, so the array cases below are what pin that swap as invisible.
describe("parseRateLimitWindow", () => {
  it("keeps a fractional percentage and the epoch reset", () => {
    expect(parseRateLimitWindow({ usedPercentage: 23.5, resetsAt_sec: 1738425600 })).toEqual({ usedPercentage: 23.5, resetsAt_sec: 1738425600 });
  });

  // Absent is not zero: a gauge reading 0% when the truth is 83% is the worst thing this can do.
  it.each([
    ["a missing percentage", { resetsAt_sec: 1738425600 }],
    ["a percentage that is not a number", { usedPercentage: "23.5" }],
    ["NaN, which no gauge can render", { usedPercentage: Number.NaN }],
    ["an array", [{ usedPercentage: 23.5 }]],
    ["null", null],
  ])("is null for %s", (_case, raw) => {
    expect(parseRateLimitWindow(raw)).toBeNull();
  });

  // Only the percentage is required — a window with no known reset is still a real reading.
  it("keeps the window when only the reset is missing", () => {
    expect(parseRateLimitWindow({ usedPercentage: 0 })).toEqual({ usedPercentage: 0, resetsAt_sec: null });
  });
});

describe("parseRateLimits", () => {
  it("reads both windows", () => {
    expect(parseRateLimits({ fiveHour: { usedPercentage: 1 }, sevenDay: { usedPercentage: 2 } })).toEqual({
      fiveHour: { usedPercentage: 1, resetsAt_sec: null },
      sevenDay: { usedPercentage: 2, resetsAt_sec: null },
    });
  });

  // Null rather than a pair of nulls, so a caller can tell "nothing to show" from "0% used".
  it.each([
    ["neither window survives", { fiveHour: null, sevenDay: {} }],
    ["an array", [{ fiveHour: { usedPercentage: 1 } }]],
    ["a string", "fiveHour"],
    ["null", null],
  ])("is null when %s", (_case, raw) => {
    expect(parseRateLimits(raw)).toBeNull();
  });

  it("keeps the pair when only one window survives", () => {
    expect(parseRateLimits({ fiveHour: { usedPercentage: 7 }, sevenDay: null })).toEqual({
      fiveHour: { usedPercentage: 7, resetsAt_sec: null },
      sevenDay: null,
    });
  });

  it("reads the per-model windows", () => {
    expect(parseRateLimits({ fiveHour: null, sevenDay: { usedPercentage: 46 }, scoped: [{ label: "fable", usedPercentage: 74 }] })).toEqual({
      fiveHour: null,
      sevenDay: { usedPercentage: 46, resetsAt_sec: null },
      scoped: [{ label: "fable", usedPercentage: 74, resetsAt_sec: null }],
    });
  });

  // The account windows and the per-model ones are separately nullable upstream. Dropping a 74%
  // because the pair beside it was absent is the same mistake as rendering an absent window as 0.
  it("keeps a reading that is only per-model windows", () => {
    expect(parseRateLimits({ scoped: [{ label: "fable", usedPercentage: 74 }] })?.scoped).toHaveLength(1);
  });

  // A reading written before scoped windows existed, read back out of the cache file.
  it("leaves scoped absent rather than empty when there are none", () => {
    expect(parseRateLimits({ fiveHour: { usedPercentage: 7 }, sevenDay: null })).not.toHaveProperty("scoped");
  });

  it("drops an unusable scoped entry without losing the rest", () => {
    expect(parseRateLimits({ fiveHour: null, sevenDay: null, scoped: [{ usedPercentage: 74 }, { label: "fable", usedPercentage: 74 }] })?.scoped).toEqual([
      { label: "fable", usedPercentage: 74, resetsAt_sec: null },
    ]);
  });

  it("is null when scoped is the only field and holds nothing usable", () => {
    expect(parseRateLimits({ scoped: [{ label: "fable" }] })).toBeNull();
  });
});

// The label IS the information — a per-model window with no name says nothing a 7d does not.
describe("parseScopedRateLimitWindow", () => {
  it("keeps the label alongside the window", () => {
    expect(parseScopedRateLimitWindow({ label: "fable", usedPercentage: 74, resetsAt_sec: 1789110000 })).toEqual({
      label: "fable",
      usedPercentage: 74,
      resetsAt_sec: 1789110000,
    });
  });

  it.each([
    ["no label", { usedPercentage: 74 }],
    ["a blank label", { label: "  ", usedPercentage: 74 }],
    ["a label that is not a string", { label: 5, usedPercentage: 74 }],
    ["no percentage", { label: "fable" }],
    ["null", null],
  ])("is null for %s", (_case, raw) => {
    expect(parseScopedRateLimitWindow(raw)).toBeNull();
  });
});
