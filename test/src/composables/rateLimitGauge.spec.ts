import { describe, it, expect } from "vitest";
import { rateLimitReadout, gaugeWindows, gaugeTitle, resetsIn, WARN_PERCENT } from "../../../src/composables/rateLimitGauge";
import type { RateLimitSnapshot } from "../../../src/composables/rateLimitGauge";

// The note and the gauges come out of one call, so the tests below read them the same way rather
// than through two entry points that could be given different snapshots.
const gaugesOf = (snapshot: RateLimitSnapshot | null, now_ms: number) => rateLimitReadout(snapshot, now_ms).gauges;
const noteOf = (snapshot: RateLimitSnapshot | null, now_ms: number) => rateLimitReadout(snapshot, now_ms).note;

const window = (usedPercentage: number, resetsAt_sec: number | null = null) => ({ usedPercentage, resetsAt_sec });
const NOW = 1_700_000_000_000;

describe("gaugeWindows", () => {
  it("shows both windows in reading order, rounded", () => {
    expect(gaugeWindows({ fiveHour: window(26.6), sevenDay: window(83.2) }, NOW)).toEqual([
      { label: "5h", percent: 27, warn: false },
      { label: "7d", percent: 83, warn: true },
    ]);
  });

  // The rule the whole feature rests on. A window we cannot see is not an empty one — rendering
  // 0% would tell the reader they have everything left at the moment we can least prove it.
  it("omits a window rather than showing it as zero", () => {
    expect(gaugeWindows({ fiveHour: null, sevenDay: window(40) }, NOW)).toEqual([{ label: "7d", percent: 40, warn: false }]);
    expect(gaugeWindows(null, NOW)).toEqual([]);
  });

  // The "Current week (Fable)" row, after the account's own two: how much of my week is gone,
  // then which model spent it.
  it("shows the per-model windows after the account's own", () => {
    expect(gaugeWindows({ fiveHour: window(9), sevenDay: window(45), scoped: [{ label: "fable", usedPercentage: 74, resetsAt_sec: null }] }, NOW)).toEqual([
      { label: "5h", percent: 9, warn: false },
      { label: "7d", percent: 45, warn: false },
      { label: "fable", percent: 74, warn: false },
    ]);
  });

  // Same rule as every other window: a reading whose own reset has gone by is not today's.
  it("drops a per-model window whose reset has passed", () => {
    const scoped = [{ label: "fable", usedPercentage: 74, resetsAt_sec: NOW / 1000 - 1 }];
    expect(gaugeWindows({ fiveHour: window(9), sevenDay: null, scoped }, NOW)).toEqual([{ label: "5h", percent: 9, warn: false }]);
  });

  it("marks a window at the warning threshold, not only past it", () => {
    expect(gaugeWindows({ fiveHour: window(WARN_PERCENT), sevenDay: null }, NOW)[0].warn).toBe(true);
    expect(gaugeWindows({ fiveHour: window(WARN_PERCENT - 1), sevenDay: null }, NOW)[0].warn).toBe(false);
  });

  // 0 is a real reading and must render; only ABSENCE is hidden. Losing this would blank the
  // gauge at the start of every window, which is when it is most reassuring.
  it("shows a genuine zero", () => {
    expect(gaugeWindows({ fiveHour: window(0), sevenDay: null }, NOW)).toEqual([{ label: "5h", percent: 0, warn: false }]);
  });

  // A reading whose window has already reset describes a budget that no longer exists. Kept on
  // screen it reads exactly like today's number — the same failure the "absent is not zero" rule
  // above exists to prevent, arriving from the other direction.
  it("drops a window whose reset has already passed", () => {
    const past = Math.floor(NOW / 1000) - 60;
    const future = Math.floor(NOW / 1000) + 3600;
    expect(gaugeWindows({ fiveHour: window(83, past), sevenDay: window(40, future) }, NOW)).toEqual([{ label: "7d", percent: 40, warn: false }]);
  });

  // Staleness has to be PROVEN, not assumed: without a reset time there is nothing to compare, and
  // dropping the figure would hide a perfectly good reading.
  it("keeps a window whose reset time is unknown", () => {
    expect(gaugeWindows({ fiveHour: window(83, null), sevenDay: null }, NOW)).toEqual([{ label: "5h", percent: 83, warn: true }]);
  });
});

describe("rateLimitReadout gauges", () => {
  const claudeOnly = { claude: { fiveHour: window(27), sevenDay: null }, codex: null };

  // A user of one tool should not have to read a label that distinguishes nothing.
  it("marks neither agent when only one reports", () => {
    expect(gaugesOf(claudeOnly, NOW)).toEqual([{ agent: "claude", marked: false, windows: [{ label: "5h", percent: 27, warn: false }] }]);
  });

  it("marks both once both report", () => {
    const both = { claude: claudeOnly.claude, codex: { fiveHour: window(6), sevenDay: null } };
    expect(gaugesOf(both, NOW).map((g) => g.marked)).toEqual([true, true]);
  });

  // #1161, straight from the reported screenshot: `claude usage n/a | 7d 71%`. The note stands
  // where Claude's figures would be, so the Codex row beside it is a second thing on the line and
  // has to say whose it is. Unmarked, it was read as Claude's 7d with the 5h missing — and the
  // reporter concluded that Codex was not being picked up at all.
  it("marks the surviving agent when a note stands in for the other", () => {
    const noted = { claude: null, codex: { fiveHour: null, sevenDay: window(71) }, claudeProbe: "no-report" as const };
    const readout = rateLimitReadout(noted, NOW);

    expect(readout.note).toBeTruthy();
    expect(readout.gauges).toEqual([{ agent: "codex", marked: true, windows: [{ label: "7d", percent: 71, warn: false }] }]);
  });

  // The same shape without a note is a solo Codex user, who has nothing to tell it apart from.
  it("leaves the solo agent unmarked when there is no note beside it", () => {
    const solo = { claude: null, codex: { fiveHour: null, sevenDay: window(71) }, claudeProbe: "ok" as const };
    const readout = rateLimitReadout(solo, NOW);

    expect(readout.note).toBeNull();
    expect(readout.gauges.map((g) => g.marked)).toEqual([false]);
  });

  // Which is also what "codex is not installed" looks like from here — there is nothing separate
  // to render for a tool the user does not use.
  it("drops an agent with nothing to report", () => {
    expect(gaugesOf({ claude: null, codex: null }, NOW)).toEqual([]);
    expect(gaugesOf(null, NOW)).toEqual([]);
  });
});

describe("resetsIn", () => {
  const inMinutes = (m: number) => Math.floor(NOW / 1000) + m * 60;

  it("reads as hours and minutes, or minutes alone", () => {
    expect(resetsIn(inMinutes(135), NOW)).toBe("resets in 2h 15m");
    expect(resetsIn(inMinutes(20), NOW)).toBe("resets in 20m");
  });

  // A stale reading whose reset has passed should say nothing rather than count backwards.
  it("says nothing for an unknown or elapsed reset", () => {
    expect(resetsIn(null, NOW)).toBe("");
    expect(resetsIn(inMinutes(-5), NOW)).toBe("");
  });
});

describe("gaugeTitle", () => {
  it("carries the numbers and when each window resets", () => {
    const title = gaugeTitle("claude", { fiveHour: window(27, Math.floor(NOW / 1000) + 3600), sevenDay: window(83) }, NOW);
    expect(title).toContain("claude rate limit");
    expect(title).toContain("5h 27% used, resets in 1h 0m");
    expect(title).toContain("7d 83% used");
  });

  it("is empty when there is nothing to say", () => {
    expect(gaugeTitle("codex", null, NOW)).toBe("");
    expect(gaugeTitle("codex", { fiveHour: null, sevenDay: null }, NOW)).toBe("");
  });

  // This string is also the aria-label, so it has to agree with what is on screen. Filtering only
  // the rendered rows left the spoken text announcing a percentage the gauge had dropped.
  it("leaves out a window the gauge no longer shows", () => {
    const past = Math.floor(NOW / 1000) - 60;
    const limits = { fiveHour: window(83, past), sevenDay: window(40, Math.floor(NOW / 1000) + 3600) };

    expect(gaugeWindows(limits, NOW).map((w) => w.label)).toEqual(["7d"]);
    expect(gaugeTitle("claude", limits, NOW)).not.toContain("83");
    expect(gaugeTitle("claude", limits, NOW)).toContain("7d 40% used");
  });

  it("says nothing at all when every window it holds has expired", () => {
    const past = Math.floor(NOW / 1000) - 60;
    expect(gaugeTitle("claude", { fiveHour: window(83, past), sevenDay: null }, NOW)).toBe("");
  });
});

// #1011 / #1010: an absent Claude gauge used to be indistinguishable from a probe loop running
// every 90 seconds in the background. The note is how a user finds out that nothing is coming —
// and, for two of the three reasons, that nothing will come until they change something.
describe("rateLimitReadout note", () => {
  const snap = (over: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({ claude: null, codex: null, ...over });

  it("says nothing while the figures are showing", () => {
    expect(noteOf(snap({ claude: { fiveHour: { usedPercentage: 5, resetsAt_sec: null }, sevenDay: null }, claudeProbe: "no-report" }), NOW)).toBeNull();
  });

  it("says nothing when it simply has not been measured yet", () => {
    expect(noteOf(snap(), NOW)).toBeNull();
    expect(noteOf(snap({ claudeProbe: "ok" }), NOW)).toBeNull();
    expect(noteOf(null, NOW)).toBeNull();
  });

  it("names the reason when there is one", () => {
    expect(noteOf(snap({ claudeProbe: "no-claude" }), NOW)).toContain("PATH");
    expect(noteOf(snap({ claudeProbe: "no-windows" }), NOW)).toContain("API-key");
    expect(noteOf(snap({ claudeProbe: "no-report" }), NOW)).toContain("Retrying");
  });

  // The case the note existed for and did not cover. A cached reading survives a restart, so
  // uninstalling `claude` left yesterday's percentage on screen with nothing said — the note was
  // suppressed by the very value that had gone stale.
  it("speaks up when the only reading it holds has already expired", () => {
    const expired = { fiveHour: { usedPercentage: 83, resetsAt_sec: Math.floor(NOW / 1000) - 60 }, sevenDay: null };
    expect(noteOf(snap({ claude: expired, claudeProbe: "no-claude" }), NOW)).toContain("PATH");
  });

  // #1293. The probe now waits on a trust dialog instead of confirming it by accident, so a user
  // whose workspace was never trusted gets a permanent `n/a` — and the one thing they need to know
  // is that ten seconds in a terminal fixes it. "Retrying, less often each time" does not say that.
  it("says how to clear a trust prompt when that is what the probe is stuck on", () => {
    const note = noteOf(snap({ claudeProbe: "no-report", claudeStall: "trust-prompt" }), NOW);
    expect(note).toContain("trust prompt");
    expect(note).toContain("claude");
  });

  it("falls back to the general silence when the screen proved nothing", () => {
    expect(noteOf(snap({ claudeProbe: "no-report", claudeStall: "unknown" }), NOW)).toContain("Retrying");
  });

  // A stall belongs to a silence and nothing else; a state that carries its own reason must not be
  // overwritten by one left over from an earlier probe.
  it("ignores a stall that does not belong to the current state", () => {
    expect(noteOf(snap({ claudeProbe: "no-claude", claudeStall: "trust-prompt" }), NOW)).toContain("PATH");
  });
});
