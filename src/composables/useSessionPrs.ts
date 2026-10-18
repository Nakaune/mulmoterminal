// The pull requests THIS session opened or changed, for the header chip.
//
// Keyed by session rather than by directory, which is the whole difference from useWorkItem: a
// cell that works in worktrees creates its requests somewhere other than the directory it is
// sitting in, so the branch-derived chip stays blank for exactly the sessions that have done the
// most. This one follows the session wherever it worked.
//
// Same cadence and the same reasoning as useWorkItem — the server answers from a store it already
// keeps, so polling faster buys nothing and a user who has just opened a PR expects the two PR
// chips to catch up together.
import { ref, watch, type Ref } from "vue";
import { usePollWhileVisible } from "./usePollWhileVisible";
import { isSessionPr, type SessionPr } from "../../common/sessionPr";
import { isUnknownArray } from "../../common/isUnknownArray";
import { jsonBody } from "../jsonBody";
import { fetchWithTimeout } from "../utils/fetchWithTimeout";

const POLL_MS = 30_000;

export function useSessionPrs(session: Ref<string | null>) {
  const prs = ref<SessionPr[]>([]);
  let req = 0;

  async function refresh(): Promise<void> {
    // Bumped before the early return for the same reason as useWorkItem: a cell that loses its
    // session must invalidate an in-flight fetch, or the previous session's requests reappear.
    const my = ++req;
    const id = session.value;
    if (!id) {
      prs.value = [];
      return;
    }
    try {
      const res = await fetchWithTimeout(`/api/session-prs/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const data = await jsonBody(res);
      if (my !== req) return;
      // The server is the only writer of this shape, but it is still a network response: an old
      // build or a proxy returning HTML would otherwise put `undefined` in an href.
      prs.value = isUnknownArray(data.prs) ? data.prs.filter(isSessionPr) : [];
    } catch {
      // leave the last value; the next tick retries
    }
  }

  usePollWhileVisible(() => void refresh(), POLL_MS);
  // Watched rather than left to the tick: a cell that has just been given a session should not
  // wait half a minute to say what that session has been doing.
  watch(session, () => void refresh());

  return { prs, refresh };
}
