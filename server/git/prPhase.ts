// The workflow phase of a branch's pull request, for the grid's cockpit roster: is this
// cell's work sitting in the PR review loop, ready to merge, already merged, or has no PR
// yet? An open-first `gh pr list --head` (one call, or a second `--state all` only when
// there's no open PR), cached briefly per (repo, branch) so a per-cell roster poll doesn't
// shell out to gh every tick. Pure parse + derivation keep it unit-testable.
//
// The cwd → (repo, branch) resolution lives at the route (server/index.ts), same as the
// header's PR button — this module takes an already-resolved repo/branch so it stays free
// of the config/header layer.
import type { CiState } from "../../common/ghItems.js";
import { EMPTY_WORK_ITEM, issueCandidateFromBranch, issueRefFromPrBody, type PrPhase, type WorkItem } from "../../common/prPhase.js";
import { runGh } from "./gh.js";
import { runGlab, glabMrForBranchArgs, glabMrViewArgs, glabTarget, type GlabTarget } from "./glab.js";
import { firstGlabMr, glabMrPhase } from "./glab-items.js";
import { forgeFromRepoEntry } from "./forge-host.js";

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
import { rollupCiState } from "./prs.js";
import { createTtlCache } from "./ttl-cache.js";
import { branchQuery, type BranchQueryDeps } from "./branch-query.js";
import { isRecord } from "../../common/isRecord.js";

export interface ParsedPr {
  state: string; // OPEN | MERGED | CLOSED
  isDraft: boolean;
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  ci: CiState; // passing | failing | pending | none
  // GitHub の `mergeable`: MERGEABLE | CONFLICTING | UNKNOWN。UNKNOWN は「まだ計算中」で、
  // 開いた直後の PR が必ず一度は通る値なので、競合と同じ扱いにしてはいけない。
  mergeable: string;
  url: string | null;
  number: number | null;
  title: string;
  // The PR description, read ONLY for its closing keyword (`Fixes #966`) — that is how the cell
  // learns which issue its work belongs to.
  body: string;
}

const toParsedPr = (o: Record<string, unknown>): ParsedPr => ({
  state: typeof o.state === "string" ? o.state : "",
  isDraft: o.isDraft === true,
  reviewDecision: typeof o.reviewDecision === "string" ? o.reviewDecision : "",
  ci: rollupCiState(o.statusCheckRollup),
  mergeable: typeof o.mergeable === "string" ? o.mergeable : "",
  url: typeof o.url === "string" ? o.url : null,
  number: typeof o.number === "number" && Number.isSafeInteger(o.number) ? o.number : null,
  title: typeof o.title === "string" ? o.title : "",
  body: typeof o.body === "string" ? o.body : "",
});

// Every PR in `gh pr list --json ...` output (empty on malformed / no PRs).
export function parsePrList(stdout: string): ParsedPr[] {
  let arr: unknown;
  try {
    arr = JSON.parse(stdout);
  } catch {
    return [];
  }
  return Array.isArray(arr) ? arr.filter(isRecord).map(toParsedPr) : [];
}

// Pure lifecycle mapping. For an OPEN PR the order encodes what needs attention first:
// still a draft → CONFLICTING → CI failing → review asked for changes → CI still running →
// otherwise green and unblocked (ready to merge).
//
// Conflict outranks a failing CI because it is the one that must be dealt with first: nothing
// merges until the branch is rebased, and the checks that failed ran against a tree that no
// longer exists — rebasing re-runs them anyway. Showing "CI fail" there sends you to a log
// instead of to the rebase.
export function derivePrPhase(pr: ParsedPr | null): PrPhase {
  if (!pr) return "none";
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  // CONFLICTING only. `UNKNOWN` is GitHub still computing it — treating that as a conflict would
  // flash red on every PR for the first seconds of its life.
  if (pr.mergeable.toUpperCase() === "CONFLICTING") return "conflict";
  if (pr.ci === "failing") return "ci-failing";
  if (pr.reviewDecision.toUpperCase() === "CHANGES_REQUESTED") return "changes-requested";
  if (pr.ci === "pending") return "ci-running";
  return "ready";
}

// Kept as the name the route and its spec already use; the shape is the shared wire type now.
export type PrPhaseResult = WorkItem;

const GH_FIELDS = "state,isDraft,reviewDecision,statusCheckRollup,mergeable,url,number,body,title";
const cache = createTtlCache<PrPhaseResult>();

export type PrPhaseDeps = BranchQueryDeps;

const NONE: PrPhaseResult = { ...EMPTY_WORK_ITEM };

// The newest PR for `branch` in `state`. `ok` distinguishes "gh ran, no such PR" (pr:null)
// from "gh failed" — the caller must not treat a failed open-PR query as "no open PR", or a
// transient error would let a stale merged PR from a reused head win. Never throws.
async function listPr(run: typeof runGh, repo: string, branch: string, state: "open" | "all"): Promise<{ ok: boolean; pr: ParsedPr | null }> {
  try {
    const res = await run(["pr", "list", "--head", branch, "--repo", repo, "--state", state, "--json", GH_FIELDS, "--limit", "1"]);
    return res.ok ? { ok: true, pr: parsePrList(res.stdout)[0] ?? null } : { ok: false, pr: null };
  } catch {
    return { ok: false, pr: null };
  }
}

// Which issue this branch's work belongs to. The PR's own `Fixes #N` is authoritative — the
// author wrote it, and it is what GitHub will close. Only without one does the branch NAME get a
// say, and then only as a candidate: `release/2026-07-28-hotfix` offers 2026 as readily as
// `fix/966-…` offers 966, so it is confirmed against the repo before a cell claims it. A `gh`
// failure here means "no issue" rather than a guess — the whole result is cached together, so
// this costs at most one extra call per branch per TTL, and only for a branch with no PR body ref.
async function resolveIssue(run: typeof runGh, repo: string, branch: string, pr: ParsedPr | null): Promise<ResolvedIssue | null> {
  const fromBody = issueRefFromPrBody(pr?.body);
  // The branch-derived candidate has to be confirmed to exist anyway, so its title rides along on
  // a call that was already being made. A body reference is trusted without the lookup — asking
  // for the TITLE is what adds a call there, and only there (#1014).
  const number = fromBody ?? issueCandidateFromBranch(branch);
  if (number === null) return null;
  try {
    const res = await run(["issue", "view", String(number), "--repo", repo, "--json", "number,title"]);
    if (res.ok) return { number, url: issueUrl(repo, number), title: issueTitleFrom(res.stdout) };
    // A body reference stands even when the lookup fails: the PR author named it, and losing the
    // number because `gh` blinked would be worse than showing it without a title.
    return fromBody === null ? null : { number: fromBody, url: issueUrl(repo, fromBody), title: null };
  } catch {
    return fromBody === null ? null : { number: fromBody, url: issueUrl(repo, fromBody), title: null };
  }
}

interface ResolvedIssue {
  number: number;
  url: string;
  title: string | null;
}

function issueTitleFrom(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) && typeof parsed.title === "string" && parsed.title !== "" ? parsed.title : null;
  } catch {
    return null;
  }
}

const issueUrl = (repo: string, number: number): string => `https://github.com/${repo}/issues/${number}`;

// A cell watches ONE branch, so it can afford the per-request call the cross-repo list cannot:
// `mr list` carries no pipeline at all, and `mr view` is where `head_pipeline` lives (#981 step 4a
// took the cheaper answer for the list, and said so). Two calls, once per cache window.
async function gitlabPhase(target: GlabTarget, branch: string): Promise<PrPhaseResult | null> {
  const listed = await runGlab(glabMrForBranchArgs(branch, target));
  if (!listed.ok) return null;
  const first = firstGlabMr(safeJson(listed.stdout));
  if (!first) return { ...EMPTY_WORK_ITEM };
  const viewed = await runGlab(glabMrViewArgs(String(first.iid), target));
  // The list answer already has everything but the pipeline, so a failed view degrades to it
  // rather than losing the whole row.
  const detail = viewed.ok ? (safeJson(viewed.stdout) ?? first.raw) : first.raw;
  const { phase, blockedReason } = glabMrPhase(detail);
  return {
    phase,
    blockedReason,
    pr: first.iid,
    prUrl: first.url,
    prTitle: first.title || null,
    // The issue a merge request closes is not read here: GitLab has no `closes` field on the MR,
    // and the branch name is what this app anchors to anyway (#1171).
    issue: issueCandidateFromBranch(branch),
    issueUrl: null,
    issueTitle: null,
  };
}

// The PR phase for `branch`. An OPEN PR (there's at most one per head branch) is the current
// state, queried first so it can't be masked by stale merged/closed PRs from a reused head —
// only when the open query genuinely returns none do we look at `--state all`. A failed query
// resolves to `none` and is NOT cached, so the next roster poll retries instead of showing a
// stale phase.
export async function phaseForRepoBranch(repo: string, branch: string, deps: PrPhaseDeps = {}): Promise<PrPhaseResult> {
  const { run, now, ttlMs, key } = branchQuery(deps, repo, branch);
  const hit = cache.get(key, now, ttlMs);
  if (hit !== undefined) return hit;

  const forge = forgeFromRepoEntry(repo);
  if (forge?.kind === "gitlab") {
    const result = await gitlabPhase(glabTarget(forge), branch);
    if (result) cache.set(key, result, now);
    return result ?? NONE;
  }

  const result = await githubPhase(run, repo, branch);
  if (!result) return NONE;
  cache.set(key, result, now);
  return result;
}

// An OPEN PR (there is at most one per head branch) is the current state, queried first so it
// cannot be masked by stale merged/closed PRs from a reused head — only when the open query
// genuinely returns none do we look at `--state all`. Null means the query FAILED, which the
// caller turns into an uncached `none` so the next poll retries.
async function githubPhase(run: typeof runGh, repo: string, branch: string): Promise<PrPhaseResult | null> {
  const open = await listPr(run, repo, branch, "open");
  if (!open.ok) return null;
  let pr = open.pr;
  if (!pr) {
    const all = await listPr(run, repo, branch, "all");
    if (!all.ok) return null;
    pr = all.pr;
  }
  const issue = await resolveIssue(run, repo, branch, pr);
  return {
    phase: derivePrPhase(pr),
    pr: pr?.number ?? null,
    prUrl: pr?.url ?? null,
    issue: issue?.number ?? null,
    issueUrl: issue?.url ?? null,
    prTitle: pr?.title ? pr.title : null,
    issueTitle: issue?.title ?? null,
    // Always null here: GitHub's phases already say everything its API says (#981).
    blockedReason: null,
  };
}

// Test-only: drop the cache so cases don't leak across each other.
export function clearPrPhaseCache(): void {
  cache.clear();
}
