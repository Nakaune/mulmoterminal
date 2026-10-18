// The session PR chip shows numbers the user clicks, and its whole input is a field the agent
// attaches to a Bash result. A wrong reading here is either a dead link, a link to somebody
// else's request, or — for the url — script in an href. The rules are pinned rather than left to
// the shape of the object that happened to arrive.
import { describe, it, expect } from "vitest";
import {
  prFromToolOutput,
  foldSessionPr,
  isSessionPr,
  repoFromPrUrl,
  sortedSessionPrs,
  chipSessionPrs,
  SESSION_PR_LIMIT,
  type SessionPr,
} from "../../common/sessionPr";

const gitOp = (pr: unknown) => ({ stdout: "", gitOperation: { pr } });
const URL_1146 = "https://github.com/example/project/pull/1146";
// Assembled rather than written out: a static http:// literal trips sonarjs/no-clear-text-protocols,
// and the insecure scheme is the whole subject of the case below.
const INSECURE_URL = ["http", "://github.com/o/r/pull/12"].join("");

describe("prFromToolOutput", () => {
  it("reads the number, url and action off a created request", () => {
    expect(prFromToolOutput(gitOp({ number: 1146, url: URL_1146, action: "created" }), 5)).toEqual({
      number: 1146,
      url: URL_1146,
      repo: "example/project",
      created: true,
      at: 5,
    });
  });

  it("records an edit as an act on the request, but not as opening it", () => {
    expect(prFromToolOutput(gitOp({ number: 1146, url: URL_1146, action: "edited" }), 5)?.created).toBe(false);
  });

  // The overwhelming majority of tool calls. A `gh pr view` carries no gitOperation, which is what
  // keeps a READ out of a history of changes.
  it.each([
    ["no gitOperation", { stdout: URL_1146 }],
    ["no pr", { gitOperation: { commit: { sha: "abc" } } }],
    ["not an object at all", "https://github.com/o/r/pull/1"],
    ["null", null],
  ])("says nothing about %s", (_label, output) => {
    expect(prFromToolOutput(output, 5)).toBeNull();
  });

  // Each of these would render — as a link to nothing, as "#1e+20", or as script that runs on
  // click. Dropping the record is the only safe answer; the agent's own terminal still has it.
  it.each([
    ["no number", { url: URL_1146, action: "created" }],
    ["number zero", { number: 0, url: URL_1146 }],
    ["a negative number", { number: -3, url: URL_1146 }],
    ["an unsafe integer", { number: 1e20, url: URL_1146 }],
    ["no url", { number: 12 }],
    ["a javascript: url", { number: 12, url: "javascript:alert(1)" }],
    ["a plain http url", { number: 12, url: INSECURE_URL }],
  ])("refuses %s", (_label, pr) => {
    expect(prFromToolOutput(gitOp(pr), 5)).toBeNull();
  });
});

describe("repoFromPrUrl", () => {
  it.each([
    ["https://github.com/example/project/pull/1146", "example/project"],
    ["https://gitlab.example.com/group/sub/proj/-/merge_requests/7", "group/sub/proj"],
    ["https://example.com/something/else", null],
  ])("%s => %s", (url, repo) => {
    expect(repoFromPrUrl(url)).toBe(repo);
  });
});

describe("foldSessionPr", () => {
  const pr = (over: Partial<SessionPr> = {}): SessionPr => ({ number: 1, url: "https://h/o/r/pull/1", repo: "o/r", created: false, at: 1, ...over });

  it("keeps the fact that this session opened it, however many edits follow", () => {
    const list: SessionPr[] = [];
    foldSessionPr(list, pr({ created: true, at: 1 }));
    foldSessionPr(list, pr({ created: false, at: 2 }));
    expect(list).toEqual([pr({ created: true, at: 2 })]);
  });

  // Two repositories both have a #12. Merging them would link one of them to the wrong place.
  it("separates the same number in two repositories", () => {
    const list: SessionPr[] = [];
    foldSessionPr(list, pr({ number: 12, url: "https://h/o/a/pull/12" }));
    foldSessionPr(list, pr({ number: 12, url: "https://h/o/b/pull/12" }));
    expect(list).toHaveLength(2);
  });

  it("reports whether the history actually changed", () => {
    const list: SessionPr[] = [];
    expect(foldSessionPr(list, pr({ at: 1 }))).toBe(true);
    expect(foldSessionPr(list, pr({ at: 1 }))).toBe(false);
    expect(foldSessionPr(list, pr({ at: 2 }))).toBe(true);
  });

  it("drops the oldest once the history is full", () => {
    const list: SessionPr[] = [];
    for (let n = 1; n <= SESSION_PR_LIMIT + 1; n++) foldSessionPr(list, pr({ number: n, url: `https://h/o/r/pull/${n}` }));
    expect(list).toHaveLength(SESSION_PR_LIMIT);
    expect(list[0]?.number).toBe(2);
  });
});

describe("sortedSessionPrs", () => {
  const at = (n: number): SessionPr => ({ number: n, url: `https://h/o/r/pull/${n}`, repo: "o/r", created: false, at: n });

  it("puts the most recent act first without mutating the store's array", () => {
    const list = [at(1), at(3), at(2)];
    expect(sortedSessionPrs(list).map((p) => p.number)).toEqual([3, 2, 1]);
    expect(list.map((p) => p.number)).toEqual([1, 3, 2]);
  });
});

describe("isSessionPr", () => {
  it("accepts what the server writes", () => {
    expect(isSessionPr({ number: 1, url: "https://h/o/r/pull/1", repo: "o/r", created: true, at: 1 })).toBe(true);
    expect(isSessionPr({ number: 1, url: "https://h/o/r/pull/1", repo: null, created: true, at: 1 })).toBe(true);
  });

  // The store drops a bad entry rather than failing the read, so this guard is the only thing
  // between a hand-edited file and an href built from `undefined`.
  it.each([
    ["a missing number", { url: "https://h/o/r/pull/1", repo: null, created: true, at: 1 }],
    ["a number of zero", { number: 0, url: "https://h/o/r/pull/1", repo: null, created: true, at: 1 }],
    ["a missing url", { number: 1, repo: null, created: true, at: 1 }],
    ["a repo of the wrong type", { number: 1, url: "https://h/o/r/pull/1", repo: 7, created: true, at: 1 }],
    ["nothing at all", null],
  ])("rejects %s", (_label, value) => {
    expect(isSessionPr(value)).toBe(false);
  });
});

// What the header actually draws. The store keys by url because two repositories both have a #12,
// but the reader sees only "#12" — so the last word on what reaches the chip is this.
describe("chipSessionPrs", () => {
  const pr = (over: Partial<SessionPr> = {}): SessionPr => ({ number: 1, url: "https://h/o/r/pull/1", repo: "o/r", created: false, at: 1, ...over });

  it("shows one entry per number, newest act first", () => {
    const list = [
      pr({ number: 12, url: "https://h/o/a/pull/12", at: 1 }),
      pr({ number: 9, at: 2, url: "https://h/o/r/pull/9" }),
      pr({ number: 12, url: "https://h/o/b/pull/12", at: 3 }),
    ];
    expect(chipSessionPrs(list, null).map((p) => p.number)).toEqual([12, 9]);
  });

  // Opening it is the stronger fact, and it must survive whichever entry wins the slot.
  it("keeps `created` when it merges two entries under one number", () => {
    const list = [
      pr({ number: 12, url: "https://h/o/a/pull/12", created: true, at: 1 }),
      pr({ number: 12, url: "https://h/o/b/pull/12", created: false, at: 2 }),
    ];
    expect(chipSessionPrs(list, null)).toEqual([{ ...pr({ number: 12, url: "https://h/o/b/pull/12", created: true, at: 2 }) }]);
  });

  // The header is read as one line. WorkItemChip draws the branch's request a few pixels away, and
  // the same number in both chips reads as a bug in one of them.
  it("drops the request the work chip is already showing", () => {
    const list = [pr({ number: 1315, url: "https://h/o/r/pull/1315", at: 3 }), pr({ number: 1314, url: "https://h/o/r/pull/1314", at: 2 })];
    expect(chipSessionPrs(list, 1315).map((p) => p.number)).toEqual([1314]);
  });

  // A merged request leaves the work chip. Hiding it here too would take the number off the header
  // entirely, for a cell that is still sitting on that branch — so the caller passes null and this
  // shows it.
  it("shows it again once the caller stops claiming the work chip has it", () => {
    const list = [pr({ number: 1315, url: "https://h/o/r/pull/1315", at: 3 })];
    expect(chipSessionPrs(list, null).map((p) => p.number)).toEqual([1315]);
  });

  it("does not mutate the store's entries", () => {
    const list = [
      pr({ number: 12, url: "https://h/o/a/pull/12", created: false, at: 1 }),
      pr({ number: 12, url: "https://h/o/b/pull/12", created: true, at: 2 }),
    ];
    chipSessionPrs(list, null);
    expect(list.map((p) => p.created)).toEqual([false, true]);
  });
});
