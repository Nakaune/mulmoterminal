import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scopedWindowsFromConfig, readClaudeScopedWindows, readUsageCacheFetchedAt, isoToEpochSec, USAGE_CACHE_MAX_AGE_MS } from "./claude-usage-cache";

// Copied from a real ~/.claude.json on 2026-09-06, trimmed to the fields this reads. The `limits`
// array is the shape /usage draws its rows from; only the scoped row is this file's business.
const NOW_MS = 1788707600000;
const FETCHED_AT_MS = 1788707545160;
const config = (limits: unknown, fetchedAtMs: number = FETCHED_AT_MS) => ({
  cachedUsageUtilization: {
    fetchedAtMs,
    accountUuid: "3ec890a3-ab52-4567-96ca-2e65b10f6c73",
    utilization: { five_hour: { utilization: 10 }, seven_day: { utilization: 46 }, limits },
  },
});
const sessionRow = { kind: "session", group: "session", percent: 10, resets_at: "2026-09-06T17:00:00.420575+00:00", scope: null };
const weeklyAllRow = { kind: "weekly_all", group: "weekly", percent: 46, resets_at: "2026-09-11T07:00:00.420595+00:00", scope: null };
const fableRow = {
  kind: "weekly_scoped",
  group: "weekly",
  percent: 74,
  resets_at: "2026-09-11T07:00:00.420816+00:00",
  scope: { model: { id: null, display_name: "Fable" }, surface: null },
  is_active: true,
};

describe("scopedWindowsFromConfig", () => {
  it("takes the per-model row and labels it with the server's own name", () => {
    expect(scopedWindowsFromConfig(config([sessionRow, weeklyAllRow, fableRow]), NOW_MS)).toEqual([
      { label: "fable", usedPercentage: 74, resetsAt_sec: 1789110000 },
    ]);
  });

  // The 5h and 7d are the probe's to report. Reading them here too is how two sources of one
  // number come to disagree.
  it("ignores the account's own rows", () => {
    expect(scopedWindowsFromConfig(config([sessionRow, weeklyAllRow]), NOW_MS)).toEqual([]);
  });

  // Nothing refreshes this file on a schedule, and a weekly window's own reset is days away — so
  // the stamp is the only thing that can say the number has stopped being about now.
  it("drops a cache older than the maximum age", () => {
    expect(scopedWindowsFromConfig(config([fableRow], NOW_MS - USAGE_CACHE_MAX_AGE_MS - 1), NOW_MS)).toEqual([]);
  });

  it("keeps a cache exactly at the maximum age", () => {
    expect(scopedWindowsFromConfig(config([fableRow], NOW_MS - USAGE_CACHE_MAX_AGE_MS), NOW_MS)).toHaveLength(1);
  });

  // A stamp we cannot read is not a fresh one. Treating it as fresh would show a percentage of
  // unknown age, which is the one thing the age check exists to prevent.
  it("says nothing when the stamp is missing", () => {
    expect(scopedWindowsFromConfig({ cachedUsageUtilization: { utilization: { limits: [fableRow] } } }, NOW_MS)).toEqual([]);
  });

  // An unnamed row cannot be drawn: the label IS the information.
  it("drops a scoped row with no model name", () => {
    expect(scopedWindowsFromConfig(config([{ ...fableRow, scope: { model: { display_name: "  " } } }]), NOW_MS)).toEqual([]);
  });

  // Absent is not zero — the rule the whole gauge is built on.
  it("drops a scoped row with no percentage", () => {
    expect(scopedWindowsFromConfig(config([{ ...fableRow, percent: null }]), NOW_MS)).toEqual([]);
  });

  // An unparseable reset does not cost the reading; the gauge already handles an unknown reset.
  it("keeps a row whose reset time is unreadable", () => {
    expect(scopedWindowsFromConfig(config([{ ...fableRow, resets_at: "soon" }]), NOW_MS)).toEqual([{ label: "fable", usedPercentage: 74, resetsAt_sec: null }]);
  });

  it.each([null, undefined, "x", 7, [], {}, { cachedUsageUtilization: 5 }])("says nothing for %o", (input) => {
    expect(scopedWindowsFromConfig(input, NOW_MS)).toEqual([]);
  });
});

describe("isoToEpochSec", () => {
  it("converts the ISO stamp Claude writes", () => {
    expect(isoToEpochSec("2026-09-11T07:00:00.420816+00:00")).toBe(1789110000);
  });

  it.each([null, undefined, "", "soon", 1789110000])("is null for %o", (input) => {
    expect(isoToEpochSec(input)).toBeNull();
  });
});

describe("readClaudeScopedWindows", () => {
  it("reads the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-claude-usage-"));
    const file = path.join(dir, ".claude.json");
    writeFileSync(file, JSON.stringify(config([fableRow])));
    try {
      expect(readClaudeScopedWindows(file, NOW_MS)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The file belongs to another program and is rewritten while we read it. Neither a missing file
  // nor a half-written one may take the poll down.
  it("says nothing for a missing file", () => {
    expect(readClaudeScopedWindows(path.join(tmpdir(), "mt-no-such-claude.json"), NOW_MS)).toEqual([]);
  });

  it("says nothing for a half-written file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-claude-usage-"));
    const file = path.join(dir, ".claude.json");
    writeFileSync(file, '{"cachedUsageUtilization":{"fetchedAtMs"');
    try {
      expect(readClaudeScopedWindows(file, NOW_MS)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The stamp is what the probe watches after sending `/usage` (rate-limit-probe.ts): a change means
// the per-model windows above have been refreshed. Nothing else about the file is its business.
describe("readUsageCacheFetchedAt", () => {
  const withFile = (contents: string | null, read: (file: string) => number | null) => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-usage-stamp-"));
    const file = path.join(dir, ".claude.json");
    try {
      if (contents !== null) writeFileSync(file, contents);
      return read(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it("reads the stamp claude wrote", () => {
    expect(withFile(JSON.stringify(config([fableRow])), readUsageCacheFetchedAt)).toBe(FETCHED_AT_MS);
  });
  it("is null for a missing file, a half-written one, or a config with no cache yet", () => {
    expect(withFile(null, readUsageCacheFetchedAt)).toBeNull();
    expect(withFile('{"cachedUsageUtilization": {"fetchedAtMs": 17', readUsageCacheFetchedAt)).toBeNull();
    expect(withFile(JSON.stringify({ projects: {} }), readUsageCacheFetchedAt)).toBeNull();
  });
  it("is null for a stamp that is not a number", () => {
    expect(withFile(JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: "soon" } }), readUsageCacheFetchedAt)).toBeNull();
  });
});
