// Which sessions a second screen should be offered, and where the list comes from.
//
// Split from the route for the same reason reconnectPolicy is split from the connection manager:
// the express handler is plumbing, and the part with consequences is WHICH sessions make the list.
// Get it wrong in one direction and a phone's list is buried under workers and the hidden
// rate-limit probe; wrong in the other and the session the user is working in never appears.
//
// The source is tmux, not this process's PTY table. That was the first attempt and it was wrong:
// a `PtyEntry` exists only while some browser is attached, so a freshly restarted server reports
// two sessions where sixteen are running — and the case this exists for is precisely the one where
// the other browser is NOT there. The `mt-<id>` tmux sessions outlive both the server and every
// client, which is what makes them the durable answer to "what is running on this machine".
import { isTerminalAgent, type SessionAgent, type TerminalAgent } from "../../common/sessionAgent.js";

/** What a client needs to adopt a session as a cell. */
export interface LiveSessionRow {
  id: string;
  /** Not decoration: a codex session adopted as claude reconnects on the wrong endpoint (#1189). */
  agent: TerminalAgent;
  /** Null when nothing recorded one — the client falls back to its own default. */
  cwd: string | null;
}

export interface LiveSessionLookup {
  /** What the session runs: its live PTY's own answer, else what tmux says is in the pane. Null
   *  when neither can say — a session that outlived the record of what launched it. */
  agent: (id: string) => SessionAgent | null;
  /** The directory remembered for the session, which survives a restart. */
  cwd: (id: string) => string | null;
  /** Not a chat anyone asked to look at: a background worker, a translation worker, the probe. */
  excluded: (id: string) => boolean;
}

/**
 * The adoptable sessions, in the order the ids arrive, each one at most once.
 *
 * A session whose agent cannot be named is DROPPED rather than defaulted to Claude. The two cases
 * are a plain shell and a session nothing recorded, and neither is a conversation: the grid has no
 * way to hold a shell as an agent cell, and adopting one as Claude would offer to resume a shell as
 * a chat. `asTerminalAgent` reads an unknown value as Claude, correctly, for a REMEMBERED cell —
 * that is the opposite question from this one, and using it here is how the wrong cell gets made.
 */
export function liveSessionRows(ids: Iterable<string>, look: LiveSessionLookup): LiveSessionRow[] {
  const rows: LiveSessionRow[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id) || look.excluded(id)) continue;
    seen.add(id);
    const agent = look.agent(id);
    if (agent === null || !isTerminalAgent(agent)) continue;
    rows.push({ id, agent, cwd: look.cwd(id) });
  }
  return rows;
}
