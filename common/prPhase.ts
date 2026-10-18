// What a cell is working on, as it travels between the two sides: the branch's PR, its phase in
// the review loop, and the issue that PR closes. Shared because BOTH sides decide from it — the
// server derives it from `gh`, the client decides what the header chip shows — and it used to be
// two declarations with a "keep them in sync" comment on one of them (src/components/rosterPhase.ts).

// Ordered roughly along the lifecycle so the client can pick a colour/label per phase.
// `none` = no PR for this branch yet (still local work); `ready` = open, CI green, no
// changes requested — i.e. waiting to merge.
export type PrPhase = "none" | "draft" | "conflict" | "ci-failing" | "changes-requested" | "ci-running" | "ready" | "merged" | "closed";

export const PR_PHASES: readonly PrPhase[] = ["none", "draft", "conflict", "ci-failing", "changes-requested", "ci-running", "ready", "merged", "closed"];

export const isPrPhase = (v: unknown): v is PrPhase => typeof v === "string" && PR_PHASES.some((phase) => phase === v);

// The /api/pr-phase response. `phase` and `prUrl` predate the rest and the roster reads them;
// the numbers are what lets a cell say WHICH work it is on rather than just how far along it is.
export interface WorkItem {
  phase: PrPhase;
  pr: number | null;
  prUrl: string | null;
  issue: number | null;
  issueUrl: string | null;
  // Titles, for the surfaces that have room for words rather than a number — the phone's session
  // list above all, where "#987" alone says nothing about which request is running (#1014).
  prTitle: string | null;
  issueTitle: string | null;
  // WHY a request that is open and not obviously failing still cannot merge. GitLab collapses into
  // one `detailed_merge_status` what GitHub splits across `isDraft`, `reviewDecision` and the check
  // rollup, and three of its values — approvals outstanding, unresolved discussions, blocked by
  // another request — have no home in `PrPhase`. Forcing them into `ready` would call something
  // unmergeable ready, and into `changes-requested` would invent a review nobody left.
  //
  // Always null on GitHub, whose phases say everything there is to say (#981).
  blockedReason: string | null;
}

export const EMPTY_WORK_ITEM: Readonly<WorkItem> = {
  phase: "none",
  pr: null,
  prUrl: null,
  issue: null,
  issueUrl: null,
  prTitle: null,
  issueTitle: null,
  blockedReason: null,
};

// One line for a surface with room for one: what the work is FOR beats what was done about it, so
// the issue's title wins when there is one. Null when neither side has a title to show.
export function workItemHeadline(item: WorkItem): string | null {
  return item.issueTitle ?? item.prTitle ?? null;
}

// GitHub's closing keywords, as GitHub itself matches them: any of these, then optional
// whitespace/colon, then #N. Anything else in the body is a mention, not a link — a PR that
// says "related to #12" is not working on #12.
// One character class for the separator, not `\s*:?\s+`: two adjacent whitespace quantifiers
// backtrack super-linearly on a long body, and a PR description is user input.
//
// `[1-9]\d*` rather than `\d+`: there is no issue #0, and `#0123` is not issue 123 — both are
// typos, and a typo that renders as a link to somebody else's issue is worse than no chip.
const CLOSING_VERB = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";
const CLOSING_KEYWORD = new RegExp(`\\b${CLOSING_VERB}[:\\s]+#([1-9]\\d*)`, "i");

// The other form GitHub accepts for the same statement: the issue's full URL. Each path segment
// is a run of non-slash characters rather than `\S+`, so there is nothing for the engine to
// backtrack over — same reason the separator above is one character class.
const CLOSING_URL = new RegExp(`\\b${CLOSING_VERB}[:\\s]+https?://[^\\s/]+(?:/[^\\s/]+){2}/issues/[1-9]\\d*`, "i");

// An issue or PR number as anything in this app will accept it. Shared because every surface that
// handles one applies the same rule and a divergence would show as a link to nothing: digits from
// a body or a branch name are unbounded, and `Number("9".repeat(20))` is 1e20 — which renders in
// the chip as "#1e+20" (found by Codex review). There is also no issue #0 and no negative one.
export const isIssueNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function toIssueNumber(digits: string): number | null {
  const n = Number(digits);
  return isIssueNumber(n) ? n : null;
}

// The issue a PR body says it closes, or null. Deliberately blind to the full-URL form
// (`Fixes https://github.com/o/r/issues/12`): that can name ANOTHER repository, and a number
// shown next to this cell's PR has to belong to the same repo to be clickable and true.
export function issueRefFromPrBody(body: string | null | undefined): number | null {
  const found = typeof body === "string" ? CLOSING_KEYWORD.exec(body) : null;
  return found?.[1] === undefined ? null : toIssueNumber(found[1]);
}

// Whether the body ALREADY states what merging it closes, in either form GitHub honours. Broader
// than issueRefFromPrBody on purpose, and the difference matters: that one answers "which issue in
// THIS repo" and so must ignore a URL that may name another repository, while this one answers
// "has the author already declared a closure" — where the URL form counts just as much, because
// adding a second keyword on top of it closes BOTH issues on merge (found by Codex review).
export const declaresClosingReference = (body: string | null | undefined): boolean =>
  typeof body === "string" && (CLOSING_KEYWORD.test(body) || CLOSING_URL.test(body));

// A branch named after its issue the way this repo names them: `fix/966-preserve-unknown-keys`.
// Requires a type prefix and a hyphen after the digits, so `chore/dep-updates-20260728` is not
// read as issue #20260728.
const BRANCH_ISSUE = /^[a-z][a-z-]*\/([1-9]\d*)-/;

// A CANDIDATE, never an answer: `release/2026-07-28-hotfix` yields 2026 here, and no pattern can
// tell that apart from a branch for issue #2026 — the year and the number have the same shape.
// The caller must confirm the issue exists before showing it, or a cell claims to be working on
// somebody else's issue. Named for the doubt so a call site can't forget it.
export function issueCandidateFromBranch(branch: string | null | undefined): number | null {
  const found = typeof branch === "string" ? BRANCH_ISSUE.exec(branch) : null;
  return found?.[1] === undefined ? null : toIssueNumber(found[1]);
}

// The prefix this app gives a branch it creates FOR an issue (#1171). Shared because the two
// sides must agree on the same string: worktree creation writes it, and the reader below is only
// sound because nothing else in the app produces it.
export const ISSUE_BRANCH_PREFIX = "issue/";

const ANCHORED_ISSUE = new RegExp(`^${ISSUE_BRANCH_PREFIX}([1-9]\\d*)-`);

// The issue a branch was CREATED for. Unlike the candidate above this is not a guess — the prefix
// is one this app writes, so a match is a statement it made about its own branch. That is what
// makes it safe to derive a PR body's `Fixes #N` from: a wrong number there closes somebody
// else's issue the moment the PR merges, which no amount of confirming afterwards undoes.
export function issueFromAnchoredBranch(branch: string | null | undefined): number | null {
  const found = typeof branch === "string" ? ANCHORED_ISSUE.exec(branch) : null;
  return found?.[1] === undefined ? null : toIssueNumber(found[1]);
}
