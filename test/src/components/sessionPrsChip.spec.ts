// The chip that says which pull requests THIS session opened or edited. What a user sees is
// decided by three rules: a session that has touched none must look exactly as it did before the
// chip existed, the newest act is the one worth the space, and every number has to link to its
// own request rather than to whichever repository came first.
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SessionPrsChip from "../../../src/components/SessionPrsChip.vue";
import type { SessionPr } from "../../../common/sessionPr";

const pr = (over: Partial<SessionPr> = {}): SessionPr => ({
  number: 1146,
  url: "https://github.com/o/r/pull/1146",
  repo: "o/r",
  created: true,
  at: 1,
  ...over,
});

const mountChip = (prs: SessionPr[], hidePr: number | null = null) => mount(SessionPrsChip, { props: { prs, hidePr } });

describe("SessionPrsChip", () => {
  // The cost of being wrong here is paid by every cell that has never opened a request, which is
  // most of them — an always-on chip that says nothing is clutter in a tiled grid.
  it("renders nothing for a session that has touched no request", () => {
    expect(mountChip([]).find("[data-testid='session-prs-chip']").exists()).toBe(false);
  });

  it("links each number to its own request", () => {
    const links = mountChip([pr(), pr({ number: 12, url: "https://github.com/o/other/pull/12" })]).findAll("[data-testid='session-pr']");
    expect(links.map((a) => a.text())).toEqual(["#1146", "#12"]);
    expect(links.map((a) => a.attributes("href"))).toEqual(["https://github.com/o/r/pull/1146", "https://github.com/o/other/pull/12"]);
  });

  // ALL of them, in order. The cap of three existed because the chip shared row 1 with a
  // truncating path; on its own roster line there is a row to use, and "which requests" is the
  // question the roster is read for — a count answered a different one.
  it("shows every request, however many there are", () => {
    const many = [1, 2, 3, 4, 5].map((n) => pr({ number: n, url: `https://github.com/o/r/pull/${n}` }));
    const chip = mountChip(many);
    expect(chip.findAll("[data-testid='session-pr']").map((a) => a.text())).toEqual(["#1", "#2", "#3", "#4", "#5"]);
    expect(chip.find("[data-testid='session-prs-overflow']").exists()).toBe(false);
  });

  // Showing all of them is only safe because they wrap. A fixed height would clip the second line,
  // and nowrap would run the row off its own edge.
  it("wraps rather than running off the row", () => {
    const cls = mountChip([1, 2].map((n) => pr({ number: n, url: `https://github.com/o/r/pull/${n}` })))
      .find("[data-testid='session-prs-chip']")
      .classes();
    expect(cls).toContain("flex-wrap");
    expect(cls).not.toContain("whitespace-nowrap");
    expect(cls.some((c) => c.startsWith("h-["))).toBe(false);
  });

  it("says in the title whether this session opened the request or only changed it", () => {
    const chip = mountChip([pr({ created: true }), pr({ number: 9, url: "https://github.com/o/r/pull/9", created: false })]);
    expect(chip.findAll("[data-testid='session-pr']").map((a) => a.attributes("title"))).toEqual(["opened o/r#1146", "edited o/r#9"]);
  });

  // A url this app could not read a project path out of still gets a number and a link; only the
  // name is missing, and inventing one would be worse than the gap.
  it("leaves the repository out of the title when the url does not carry one", () => {
    const chip = mountChip([pr({ repo: null })]);
    expect(chip.find("[data-testid='session-pr']").attributes("title")).toBe("opened #1146");
  });

  // The header is read as one line: WorkItemChip draws the branch's request a few pixels away, and
  // the same number twice reads as a bug in one of the two chips.
  it("drops the request the work chip is already showing", () => {
    const chip = mountChip([pr(), pr({ number: 9, url: "https://github.com/o/r/pull/9" })], 1146);
    expect(chip.findAll("[data-testid='session-pr']").map((a) => a.text())).toEqual(["#9"]);
  });

  it("renders nothing when the only request it had is the work chip's", () => {
    expect(mountChip([pr()], 1146).find("[data-testid='session-prs-chip']").exists()).toBe(false);
  });

  // The work chip's request is still dropped — that rule is about not printing the same number
  // twice on one row, and it survives the cap going away.
  it("still drops the work chip's request from the list", () => {
    const many = [1, 2, 3, 4].map((n) => pr({ number: n, url: `https://github.com/o/r/pull/${n}` }));
    const chip = mountChip(many, 1);
    expect(chip.findAll("[data-testid='session-pr']").map((a) => a.text())).toEqual(["#2", "#3", "#4"]);
  });

  // The 18ch cap this once had clipped `PR #1313 #1314 #1315` (20ch) with overflow-hidden, so the
  // last number was drawn half-wide and still looked like a number.
  it("carries no width cap that could clip a number", () => {
    const chip = mountChip([1313, 1314, 1315].map((n) => pr({ number: n, url: `https://github.com/o/r/pull/${n}` })));
    const cls = chip.find("[data-testid='session-prs-chip']").classes();
    expect(cls).not.toContain("overflow-hidden");
    expect(cls.some((c) => c.startsWith("max-w-"))).toBe(false);
    expect(cls.some((c) => c.startsWith("max-h-"))).toBe(false);
  });
});
