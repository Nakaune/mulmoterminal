// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";

import { derivePrPhase, parsePrList, phaseForRepoBranch, clearPrPhaseCache, type ParsedPr } from "../../../server/git/prPhase.js";

const pr = (over: Partial<ParsedPr> = {}): ParsedPr => ({
  state: "OPEN",
  isDraft: false,
  reviewDecision: "",
  ci: "passing",
  mergeable: "MERGEABLE",
  url: null,
  number: null,
  body: "",
  title: "",
  ...over,
});

describe("derivePrPhase", () => {
  // 競合は CI 失敗より前。枝を rebase しない限り何も進まず、落ちた checks は既に無い木に
  // 対して走った結果なので、そこで "CI fail" を出すと log へ送ってしまう。
  it("reports a conflict ahead of a failing CI", () => {
    expect(derivePrPhase(pr({ mergeable: "CONFLICTING", ci: "failing" }))).toBe("conflict");
  });

  // draft は競合より前のまま。まだ見せる前のものに「直せ」と言っても仕方がない。
  it("keeps draft ahead of a conflict", () => {
    expect(derivePrPhase(pr({ isDraft: true, mergeable: "CONFLICTING" }))).toBe("draft");
  });

  // GitHub が計算し終えるまでの値。ここを競合にすると、開いた直後の PR が必ず一度赤くなる。
  it.each(["UNKNOWN", "", "MERGEABLE"])("does not call %o a conflict", (mergeable) => {
    expect(derivePrPhase(pr({ mergeable }))).toBe("ready");
  });

  // merged / closed は mergeable が何であれ関係ない。
  it("does not report a conflict on a closed request", () => {
    expect(derivePrPhase(pr({ state: "CLOSED", mergeable: "CONFLICTING" }))).toBe("closed");
  });

  it("returns none when there is no PR", () => {
    expect(derivePrPhase(null)).toBe("none");
  });

  it.each([
    ["MERGED", "merged"],
    ["merged", "merged"],
    ["CLOSED", "closed"],
  ])("maps state %s to %s", (state, expected) => {
    expect(derivePrPhase(pr({ state }))).toBe(expected);
  });

  it("maps a draft PR to draft", () => {
    expect(derivePrPhase(pr({ isDraft: true }))).toBe("draft");
  });

  it("maps an open PR with failing CI to ci-failing", () => {
    expect(derivePrPhase(pr({ ci: "failing" }))).toBe("ci-failing");
  });

  it("maps an open PR with changes requested to changes-requested", () => {
    expect(derivePrPhase(pr({ reviewDecision: "CHANGES_REQUESTED", ci: "passing" }))).toBe("changes-requested");
  });

  it("maps an open PR with pending CI to ci-running", () => {
    expect(derivePrPhase(pr({ ci: "pending" }))).toBe("ci-running");
  });

  it.each([["passing"], ["none"]])("maps an open PR with %s CI and no blockers to ready", (ci) => {
    expect(derivePrPhase(pr({ ci: ci as ParsedPr["ci"] }))).toBe("ready");
  });

  // Precedence: the earliest-listed blocker wins so the roster shows what needs attention first.
  it("prefers draft over every open-state blocker", () => {
    expect(derivePrPhase(pr({ isDraft: true, ci: "failing", reviewDecision: "CHANGES_REQUESTED" }))).toBe("draft");
  });

  it("prefers failing CI over changes-requested", () => {
    expect(derivePrPhase(pr({ ci: "failing", reviewDecision: "CHANGES_REQUESTED" }))).toBe("ci-failing");
  });

  it("prefers changes-requested over still-pending CI", () => {
    expect(derivePrPhase(pr({ ci: "pending", reviewDecision: "CHANGES_REQUESTED" }))).toBe("changes-requested");
  });
});

describe("parsePrList", () => {
  it("parses each PR and rolls up its CI", () => {
    const stdout = JSON.stringify([
      { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }], mergeable: "MERGEABLE", url: "u1" },
    ]);
    expect(parsePrList(stdout)).toEqual([
      { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", ci: "passing", mergeable: "MERGEABLE", url: "u1", number: null, body: "", title: "" },
    ]);
  });

  it("rolls a mixed check set with a failure to failing", () => {
    const stdout = JSON.stringify([{ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }] }]);
    expect(parsePrList(stdout)[0]?.ci).toBe("failing");
  });

  it("returns none-CI for an empty rollup", () => {
    expect(parsePrList(JSON.stringify([{ state: "OPEN", statusCheckRollup: [] }]))[0]?.ci).toBe("none");
  });

  it.each([
    ["an empty array", "[]"],
    ["malformed JSON", "{ not json"],
    ["a non-array", '{"state":"OPEN"}'],
  ])("returns an empty list for %s", (_label, stdout) => {
    expect(parsePrList(stdout)).toEqual([]);
  });

  it("defaults missing fields", () => {
    expect(parsePrList(JSON.stringify([{}]))).toEqual([
      { state: "", isDraft: false, reviewDecision: "", ci: "none", mergeable: "", url: null, number: null, body: "", title: "" },
    ]);
  });
});

describe("phaseForRepoBranch", () => {
  beforeEach(() => clearPrPhaseCache());

  // gh stub keyed by the `--state` in the args (open-first, then all).
  const ghByState = (byState: { open?: string; all?: string }, ok = true) => {
    let calls = 0;
    const states: string[] = [];
    const fn = async (args: string[]) => {
      calls += 1;
      const state = args[args.indexOf("--state") + 1];
      states.push(state);
      return { ok, stdout: (state === "open" ? byState.open : byState.all) ?? "[]", stderr: "" };
    };
    return { fn, calls: () => calls, states: () => states };
  };

  const openPr = JSON.stringify([
    { state: "OPEN", isDraft: false, statusCheckRollup: [{ conclusion: "SUCCESS" }], url: "https://github.com/o/r/pull/2", number: 2 },
  ]);

  it("derives phase and url from the open PR (one query, no fallback)", async () => {
    const gh = ghByState({ open: openPr });
    const result = await phaseForRepoBranch("o/r", "feat/x", { runGh: gh.fn });
    expect(result).toEqual({
      phase: "ready",
      pr: 2,
      prUrl: "https://github.com/o/r/pull/2",
      issue: null,
      issueUrl: null,
      prTitle: null,
      issueTitle: null,
      blockedReason: null,
    });
    expect(gh.states()).toEqual(["open"]); // never fell through to --state all
  });

  it("falls back to --state all for a merged branch (no open PR)", async () => {
    const gh = ghByState({ open: "[]", all: JSON.stringify([{ state: "MERGED", url: "u", number: 9 }]) });
    const result = await phaseForRepoBranch("o/r", "feat/x", { runGh: gh.fn });
    expect(result).toEqual({ phase: "merged", pr: 9, prUrl: "u", issue: null, issueUrl: null, prTitle: null, issueTitle: null, blockedReason: null });
    expect(gh.states()).toEqual(["open", "all"]);
  });

  // Codex iter-1/2: an open PR must never be masked by a stale merged/closed same-head PR,
  // even with many historical PRs — querying --state open first guarantees it.
  it("returns the open PR without consulting merged history for a reused head branch", async () => {
    const gh = ghByState({ open: openPr, all: JSON.stringify([{ state: "MERGED", url: "old" }]) });
    const result = await phaseForRepoBranch("o/r", "feat/x", { runGh: gh.fn });
    expect(result.prUrl).toBe("https://github.com/o/r/pull/2");
    expect(gh.states()).toEqual(["open"]);
  });

  it("resolves to none when gh fails", async () => {
    const result = await phaseForRepoBranch("o/r", "feat/x", { runGh: ghByState({}, false).fn });
    expect(result).toEqual({ phase: "none", pr: null, prUrl: null, issue: null, issueUrl: null, prTitle: null, issueTitle: null, blockedReason: null });
  });

  it("resolves to none when there is no PR at all", async () => {
    const result = await phaseForRepoBranch("o/r", "feat/x", { runGh: ghByState({ open: "[]", all: "[]" }).fn });
    expect(result).toEqual({ phase: "none", pr: null, prUrl: null, issue: null, issueUrl: null, prTitle: null, issueTitle: null, blockedReason: null });
  });

  // Codex iter-3: a FAILED open query must not fall through to --state all (which could report
  // a stale merged PR for a reused head); it resolves to none without consulting history.
  it("does not consult history when the open query fails", async () => {
    const states: string[] = [];
    const runGh = async (args: string[]) => {
      const state = args[args.indexOf("--state") + 1];
      states.push(state);
      if (state === "open") return { ok: false, stdout: "", stderr: "" };
      return { ok: true, stdout: JSON.stringify([{ state: "MERGED", url: "stale" }]), stderr: "" };
    };
    const result = await phaseForRepoBranch("o/r", "feat/x", { runGh });
    expect(result).toEqual({ phase: "none", pr: null, prUrl: null, issue: null, issueUrl: null, prTitle: null, issueTitle: null, blockedReason: null });
    expect(states).toEqual(["open"]);
  });

  // Which issue the cell is on. The PR's own closing keyword is the authority; the branch name is
  // only consulted without one, and then only after the issue is confirmed to exist — a branch
  // like `release/2026-07-28-hotfix` otherwise makes the cell claim issue #2026.
  describe("the issue behind the work", () => {
    const prWithBody = (body: string) => JSON.stringify([{ state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], url: "u", number: 3, body }]);

    it("takes the issue from the PR's closing keyword, and reads its title", async () => {
      const seen: string[][] = [];
      const runGh = async (args: string[]) => {
        seen.push(args);
        return { ok: true, stdout: args[0] === "pr" ? prWithBody("Fixes #966") : '{"number":966,"title":"the reported bug"}', stderr: "" };
      };
      const result = await phaseForRepoBranch("o/r", "fix/1-other", { runGh });
      expect(result.issue).toBe(966); // the body wins over the branch's own "1"
      expect(result.issueTitle).toBe("the reported bug");
      // The lookup exists for the TITLE — the number needed no confirming (#1014).
      expect(seen.some((args) => args[0] === "issue" && args.includes("number,title"))).toBe(true);
    });

    // The number came from the PR author, so a `gh` hiccup must not take it away — only the title.
    it("keeps a body-referenced issue when the title lookup fails", async () => {
      const runGh = async (args: string[]) => ({ ok: args[0] === "pr", stdout: args[0] === "pr" ? prWithBody("Fixes #966") : "", stderr: "no" });
      const result = await phaseForRepoBranch("o/r", "feat/x", { runGh });
      expect(result.issue).toBe(966);
      expect(result.issueTitle).toBeNull();
    });

    it("takes the PR title from the list it already fetches", async () => {
      const runGh = async (args: string[]) => ({
        ok: true,
        stdout: args[0] === "pr" ? JSON.stringify([{ state: "OPEN", url: "u", number: 3, title: "the change", body: "" }]) : "{}",
        stderr: "",
      });
      expect((await phaseForRepoBranch("o/r", "feat/x", { runGh })).prTitle).toBe("the change");
    });

    it("falls back to the branch name, confirming the issue exists first", async () => {
      const seen: string[][] = [];
      const runGh = async (args: string[]) => {
        seen.push(args);
        return { ok: true, stdout: args[0] === "pr" ? prWithBody("no keyword here") : '{"number":966}', stderr: "" };
      };
      const result = await phaseForRepoBranch("o/r", "fix/966-preserve-keys", { runGh });
      expect(result.issue).toBe(966);
      expect(result.issueUrl).toBe("https://github.com/o/r/issues/966");
      expect(seen.some((args) => args[0] === "issue" && args.includes("966"))).toBe(true);
    });

    // The guard the candidate exists for: the number parses, the issue does not exist.
    it("shows no issue when the branch's number is not a real issue", async () => {
      const runGh = async (args: string[]) => ({ ok: args[0] === "pr", stdout: args[0] === "pr" ? prWithBody("") : "", stderr: "not found" });
      const result = await phaseForRepoBranch("o/r", "release/2026-07-28-hotfix", { runGh });
      expect(result.issue).toBeNull();
      expect(result.issueUrl).toBeNull();
    });

    it("shows no issue for a branch that names none", async () => {
      const runGh = async () => ({ ok: true, stdout: prWithBody(""), stderr: "" });
      const result = await phaseForRepoBranch("o/r", "feat/no-number", { runGh });
      expect(result.issue).toBeNull();
    });

    // A cell can be on an issue before it has a PR — that is most of the time it spends on one.
    it("finds the issue with no PR at all", async () => {
      const runGh = async (args: string[]) => ({ ok: true, stdout: args[0] === "pr" ? "[]" : '{"number":979}', stderr: "" });
      const result = await phaseForRepoBranch("o/r", "feat/979-work-item-chip", { runGh });
      expect(result).toEqual({
        phase: "none",
        pr: null,
        prUrl: null,
        issue: 979,
        issueUrl: "https://github.com/o/r/issues/979",
        prTitle: null,
        issueTitle: null,

        blockedReason: null,
      });
    });
  });

  it("does not cache a failed query, so the next poll retries", async () => {
    let attempt = 0;
    const runGh = async (args: string[]) => {
      const state = args[args.indexOf("--state") + 1];
      attempt += 1;
      if (state === "open" && attempt === 1) return { ok: false, stdout: "", stderr: "" };
      return { ok: true, stdout: openPr, stderr: "" };
    };
    const first = await phaseForRepoBranch("o/r", "feat/x", { runGh, now: () => 1000 });
    expect(first.phase).toBe("none");
    const second = await phaseForRepoBranch("o/r", "feat/x", { runGh, now: () => 1000 });
    expect(second.phase).toBe("ready"); // not cached → retried → real result
  });

  it("caches within the TTL (one lookup's queries serve a second lookup)", async () => {
    const gh = ghByState({ open: openPr });
    await phaseForRepoBranch("o/r", "feat/x", { runGh: gh.fn, now: () => 1000, ttlMs: 30_000 });
    await phaseForRepoBranch("o/r", "feat/x", { runGh: gh.fn, now: () => 1000, ttlMs: 30_000 });
    expect(gh.calls()).toBe(1);
  });

  it("re-queries once the TTL has elapsed", async () => {
    const gh = ghByState({ open: openPr });
    let t = 1000;
    await phaseForRepoBranch("o/r", "feat/x", { runGh: gh.fn, now: () => t, ttlMs: 30_000 });
    t = 1000 + 31_000;
    await phaseForRepoBranch("o/r", "feat/x", { runGh: gh.fn, now: () => t, ttlMs: 30_000 });
    expect(gh.calls()).toBe(2);
  });
});
