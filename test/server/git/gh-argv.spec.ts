// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// What every read-side feature ASKS `gh` for, pinned exactly — the command, the flags, the JSON
// field list, the limits, and how many calls each feature makes.
//
// The existing specs cover the parsing (rollupCiState, normalizePr, normalizeIssue, the phase
// rules) but nothing observed the request itself, so moving these calls behind a forge interface
// (#981) could have changed what is asked for without a single test noticing. Written BEFORE that
// move, against the current implementation, so it can only agree with today's behaviour.
//
// A field dropped from a `--json` list is the failure this is really for: gh still succeeds, the
// parser still runs, and the value silently becomes its default — a PR that looks like it has no
// CI rather than one whose CI is failing.

const runGh = vi.fn();
vi.mock("../../../server/git/gh", () => ({ runGh: (args: string[]) => runGh(args) }));

const { listPrsAcrossRepos, PR_LIMIT } = await import("../../../server/git/prs");
const { listIssuesAcrossRepos, ISSUE_LIMIT } = await import("../../../server/git/issues");
const { prUrlForBranch, clearPrUrlCache } = await import("../../../server/git/pr-for-branch");
const { phaseForRepoBranch, clearPrPhaseCache } = await import("../../../server/git/prPhase");

const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });

beforeEach(() => {
  runGh.mockReset();
  runGh.mockResolvedValue(ok("[]"));
  clearPrUrlCache();
  clearPrPhaseCache();
});

describe("gh arguments — cross-repo lists", () => {
  it("asks for open PRs of one repo, with the fields the PR list renders", async () => {
    await listPrsAcrossRepos(["owner/repo"]);
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh).toHaveBeenCalledWith([
      "pr",
      "list",
      "--repo",
      "owner/repo",
      "--state",
      "open",
      "--limit",
      String(PR_LIMIT + 1),
      "--json",
      "number,title,author,updatedAt,isDraft,url,reviewDecision,statusCheckRollup",
    ]);
  });

  it("asks for open issues of one repo, with the fields the issue list renders", async () => {
    await listIssuesAcrossRepos(["owner/repo"]);
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh).toHaveBeenCalledWith([
      "issue",
      "list",
      "--repo",
      "owner/repo",
      "--state",
      "open",
      "--limit",
      String(ISSUE_LIMIT + 1),
      "--json",
      "number,title,author,updatedAt,url",
    ]);
  });

  // The limit is deliberately one MORE than the list shows, so the view can say "there are more"
  // without a second request. Moving the call must not quietly drop the +1.
  it("over-fetches by exactly one, which is how the view knows there are more", () => {
    expect(PR_LIMIT + 1).toBe(101);
    expect(ISSUE_LIMIT + 1).toBe(21);
  });

  it.each([
    ["PRs", (repos: string[]) => listPrsAcrossRepos(repos)],
    ["issues", (repos: string[]) => listIssuesAcrossRepos(repos)],
  ])("queries each repo separately when listing %s", async (_case, list) => {
    await list(["a/one", "b/two", "c/three"]);
    expect(runGh).toHaveBeenCalledTimes(3);
    expect(runGh.mock.calls.map((call) => call[0][3])).toEqual(["a/one", "b/two", "c/three"]);
  });
});

describe("gh arguments — per-branch queries", () => {
  it("asks for the open PR of a head branch, needing only its url", async () => {
    await prUrlForBranch("owner/repo", "feat/x");
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh).toHaveBeenCalledWith(["pr", "list", "--head", "feat/x", "--repo", "owner/repo", "--state", "open", "--json", "url", "--limit", "1"]);
  });

  // The open query runs FIRST and `--state all` only when it genuinely returns none, so a stale
  // merged PR on a reused head can't mask the current one. The ORDER is the behaviour here.
  it("asks for the open PR first and only then for any state, with the phase fields", async () => {
    await phaseForRepoBranch("owner/repo", "feat/x");
    expect(runGh.mock.calls.map((call) => call[0])).toEqual([
      [
        "pr",
        "list",
        "--head",
        "feat/x",
        "--repo",
        "owner/repo",
        "--state",
        "open",
        "--json",
        "state,isDraft,reviewDecision,statusCheckRollup,mergeable,url,number,body,title",
        "--limit",
        "1",
      ],
      [
        "pr",
        "list",
        "--head",
        "feat/x",
        "--repo",
        "owner/repo",
        "--state",
        "all",
        "--json",
        "state,isDraft,reviewDecision,statusCheckRollup,mergeable,url,number,body,title",
        "--limit",
        "1",
      ],
    ]);
  });

  it("stops after the open query when there IS an open PR", async () => {
    runGh.mockResolvedValue(ok(JSON.stringify([{ state: "OPEN", isDraft: false, reviewDecision: "", statusCheckRollup: [], url: "u" }])));
    await phaseForRepoBranch("owner/repo", "feat/x");
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  // Both per-branch queries cache, and a FAILURE is deliberately not cached — the next poll has
  // to retry rather than show "no PR" for the whole TTL.
  it("does not re-ask within the cache window", async () => {
    await prUrlForBranch("owner/repo", "feat/x");
    await prUrlForBranch("owner/repo", "feat/x");
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it("re-asks after a failure rather than caching it", async () => {
    runGh.mockResolvedValue({ ok: false, stdout: "", stderr: "gh: not authenticated" });
    await prUrlForBranch("owner/repo", "feat/x");
    await prUrlForBranch("owner/repo", "feat/x");
    expect(runGh).toHaveBeenCalledTimes(2);
  });
});

describe("gh arguments — one repo failing", () => {
  // One unreachable repo must not sink the whole view: the others still get their request.
  it("still queries the remaining repos", async () => {
    runGh.mockImplementation((args: string[]) => Promise.resolve(args[3] === "b/two" ? { ok: false, stdout: "", stderr: "no access" } : ok("[]")));
    const result = await listPrsAcrossRepos(["a/one", "b/two", "c/three"]);
    expect(runGh).toHaveBeenCalledTimes(3);
    expect(result.map((r) => r.repo)).toEqual(["a/one", "b/two", "c/three"]);
    expect(result.find((r) => r.repo === "b/two")?.error).toContain("no access");
  });
});
