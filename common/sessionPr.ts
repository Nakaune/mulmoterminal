// The pull requests ONE SESSION opened or changed, as they travel between the two sides.
//
// Deliberately not the same question as `WorkItem` (common/prPhase.ts). That one asks "which PR
// does this directory's current branch have", answered by `gh` every 30s — so it goes blank the
// moment the cell checks out another branch, and it never says anything at all in a workspace
// where the branch itself carries no PR. This one is a HISTORY: what this session did, kept for
// as long as the session lives, across every branch and worktree it touched.
//
// The source is Claude Code's own `gitOperation.pr` on a Bash tool result — the agent tells us
// the number, the url and whether it created or merely edited it, so nothing here has to parse a
// `gh` command line or shell out a second time.
import { isRecord } from "./isRecord.js";

/** One PR this session acted on. `at` is the LAST time it did, so the list sorts newest-first. */
export interface SessionPr {
  number: number;
  url: string;
  /** "owner/repo" when the url is shaped like one, else null — a session can touch two repos. */
  repo: string | null;
  /** Did this session OPEN it, or only change one that already existed. */
  created: boolean;
  at: number;
}

// There is no PR #0 and no negative one, and `Number("9".repeat(20))` is 1e20 — which would
// render in the chip as "#1e+20". Same rule as prPhase.isIssueNumber, kept separate only because
// importing that module here would drag the closing-keyword regexes into this one.
const isPrNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

// The url goes straight into an `<a href>`, so the scheme is not the agent's decision to make:
// `javascript:` there runs on click.
function safeHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

export const isSessionPr = (value: unknown): value is SessionPr =>
  isRecord(value) &&
  isPrNumber(value.number) &&
  typeof value.url === "string" &&
  (value.repo === null || typeof value.repo === "string") &&
  typeof value.created === "boolean" &&
  typeof value.at === "number";

// GitHub's `/pull/N` and GitLab's `/-/merge_requests/N` both put the project path in front of the
// marker, so the same slice answers for both.
const PR_PATH_MARKERS = ["/pull/", "/-/merge_requests/"] as const;

// "owner/repo" out of a request url, for the chip's hover title. Null when the url is shaped some
// other way: the number and the link still work, only the name is missing.
export function repoFromPrUrl(url: string): string | null {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  const marker = PR_PATH_MARKERS.find((m) => path.includes(m));
  if (marker === undefined) return null;
  const owner = path.slice(1, path.indexOf(marker));
  return owner === "" ? null : owner;
}

/** What a Bash tool result says the agent just did to a PR, or null for the vast majority that
 *  say nothing about one. Claude Code attaches this itself; `gh pr view` carries no
 *  `gitOperation`, so a read is not mistaken for a change. */
export function prFromToolOutput(output: unknown, now: number): SessionPr | null {
  if (!isRecord(output)) return null;
  const op = output.gitOperation;
  if (!isRecord(op)) return null;
  const pr = op.pr;
  if (!isRecord(pr) || !isPrNumber(pr.number)) return null;
  const url = safeHttpsUrl(pr.url);
  if (url === null) return null;
  return { number: pr.number, url, repo: repoFromPrUrl(url), created: pr.action === "created", at: now };
}

/** How many requests one session's history keeps. A session that has touched more than this has
 *  long since stopped being answerable by a chip, and the oldest is the one to drop. */
export const SESSION_PR_LIMIT = 20;

/** Fold one act into the history, in place, and say whether anything changed.
 *
 *  Deduped by url rather than by number: two repositories both have a #12, and a chip that
 *  merged them would link one of them to the wrong place. `created` is sticky — a session that
 *  opened a request and then edited it twice still opened it, and that is the fact worth keeping
 *  when the list has to be trimmed. */
export function foldSessionPr(list: SessionPr[], pr: SessionPr): boolean {
  const existing = list.find((p) => p.url === pr.url);
  if (existing) {
    // An edit that adds nothing new still moves it to the front of a newest-first list, so the
    // chip shows what the session is on NOW rather than what it opened first.
    const changed = existing.at !== pr.at || (pr.created && !existing.created);
    existing.at = pr.at;
    existing.created = existing.created || pr.created;
    return changed;
  }
  list.push(pr);
  if (list.length > SESSION_PR_LIMIT) list.splice(0, list.length - SESSION_PR_LIMIT);
  return true;
}

/** Newest act first. A copy: the store's array is a working copy other code mutates in place. */
export const sortedSessionPrs = (list: readonly SessionPr[]): SessionPr[] => [...list].sort((a, b) => b.at - a.at);

/** What the chip should actually draw: newest act first, one entry per NUMBER, and never the one
 *  the `work` chip is already showing.
 *
 *  Both rules exist because a header is read as one line, not as a set of independent widgets. The
 *  store keys by url — two repositories both have a #12, and merging those would link one of them
 *  to the wrong place — but the READER sees only "#12", so two identical-looking numbers side by
 *  side are noise whichever repositories they came from. The newest act wins the slot, and
 *  `created` survives the merge for the same reason it survives a fold: opening it is the stronger
 *  fact.
 *
 *  `hidePr` is the branch's request, which WorkItemChip draws a few pixels away. Passing null when
 *  that chip is NOT drawing it is the caller's job (a merged request removes itself from the work
 *  chip, and the number must not vanish from both). */
export function chipSessionPrs(list: readonly SessionPr[], hidePr: number | null): SessionPr[] {
  const byNumber = new Map<number, SessionPr>();
  for (const pr of sortedSessionPrs(list)) {
    if (pr.number === hidePr) continue;
    const seen = byNumber.get(pr.number);
    if (seen) seen.created = seen.created || pr.created;
    else byNumber.set(pr.number, { ...pr });
  }
  return [...byNumber.values()];
}
