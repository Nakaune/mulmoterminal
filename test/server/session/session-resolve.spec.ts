// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  resolveSession,
  type SessionFacts,
  resolveReattachableId,
  canStartLauncher,
  isContinuingSession,
  servesAgent,
} from "../../../server/session/session-resolve.js";

const FIXED = "fresh-minted-id";
const mint = () => FIXED;
const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({ hasLivePty: false, tmuxAlive: false, onDisk: false, ...over });

describe("resolveSession", () => {
  it("mints a fresh id when nothing is requested", () => {
    expect(resolveSession(null, facts(), mint)).toEqual({ reattachId: null, resume: null, sessionId: FIXED });
  });

  it("mints a fresh id when the requested session can't be served (not live, tmux, or on disk)", () => {
    // e.g. reloading an idle session claude never persisted — reusing its id under
    // --session-id would abort, so we start fresh and the browser adopts the new id.
    expect(resolveSession("s1", facts(), mint)).toEqual({ reattachId: null, resume: null, sessionId: FIXED });
  });

  it("reattaches a same-process live pty (no resume, id preserved)", () => {
    expect(resolveSession("s1", facts({ hasLivePty: true }), mint)).toEqual({ reattachId: "s1", resume: null, sessionId: "s1" });
  });

  it("resumes an on-disk transcript", () => {
    expect(resolveSession("s1", facts({ onDisk: true }), mint)).toEqual({ reattachId: null, resume: "s1", sessionId: "s1" });
  });

  it("reuses the id for a live tmux session with no transcript yet (idle, --session-id attaches)", () => {
    expect(resolveSession("s1", facts({ tmuxAlive: true }), mint)).toEqual({ reattachId: null, resume: null, sessionId: "s1" });
  });

  it("resumes an on-disk transcript EVEN when a tmux session is alive (the fix)", () => {
    // Regression: the old logic gated resume on !tmuxAlive, so this yielded resume:null
    // and a --session-id launch that aborts with "already in use" if the tmux session
    // died between the check and the spawn.
    expect(resolveSession("s1", facts({ tmuxAlive: true, onDisk: true }), mint)).toEqual({ reattachId: null, resume: "s1", sessionId: "s1" });
  });

  it("prefers a live pty over tmux/disk", () => {
    expect(resolveSession("s1", facts({ hasLivePty: true, tmuxAlive: true, onDisk: true }), mint)).toEqual({ reattachId: "s1", resume: null, sessionId: "s1" });
  });
});

// /ws/launch and /ws/codex reuse a requested id only when something can actually serve it.
// Handing back an id nothing can serve strands the client on a dead session.
describe("resolveReattachableId", () => {
  const mint = () => "FRESH";
  const facts = (over = {}) => ({ hasLivePty: false, tmuxAlive: false, canResume: false, ...over });

  it("mints a fresh id when nothing was requested", () => {
    expect(resolveReattachableId(null, facts(), mint)).toEqual({ reattachId: null, sessionId: "FRESH" });
  });

  it("reattaches a live pty in this process", () => {
    expect(resolveReattachableId("REQ", facts({ hasLivePty: true }), mint)).toEqual({ reattachId: "REQ", sessionId: "REQ" });
  });

  it("keeps the id for a surviving tmux session, without reattaching a pty", () => {
    expect(resolveReattachableId("REQ", facts({ tmuxAlive: true }), mint)).toEqual({ reattachId: null, sessionId: "REQ" });
  });

  it("keeps the id when there is something to resume", () => {
    expect(resolveReattachableId("REQ", facts({ canResume: true }), mint)).toEqual({ reattachId: null, sessionId: "REQ" });
  });

  it("mints a fresh id when the requested one cannot be served", () => {
    expect(resolveReattachableId("REQ", facts(), mint)).toEqual({ reattachId: null, sessionId: "FRESH" });
  });

  it("prefers the live pty when several facts hold at once", () => {
    expect(resolveReattachableId("REQ", facts({ hasLivePty: true, tmuxAlive: true, canResume: true }), mint)).toEqual({ reattachId: "REQ", sessionId: "REQ" });
  });

  it("never reattaches without a requested id, whatever the facts say", () => {
    expect(resolveReattachableId(null, facts({ hasLivePty: true, tmuxAlive: true, canResume: true }), mint)).toEqual({ reattachId: null, sessionId: "FRESH" });
  });
});

// What the worktree limit asks before refusing a spawn: is this connection creating a session, or
// continuing one? Reading it off the resolved id is the point — Codex caught the first version
// re-listing the ways a session can continue and missing tmux-only liveness, which turns a
// reconnect after a server restart into a "new session" and refuses it (#1208).
describe("isContinuingSession", () => {
  it("is false when nothing was requested", () => {
    expect(isContinuingSession(null, "FRESH")).toBe(false);
  });

  it("is false when the requested id could not be served and a fresh one was minted", () => {
    const { sessionId } = resolveReattachableId("REQ", { hasLivePty: false, tmuxAlive: false, canResume: false }, () => "FRESH");
    expect(isContinuingSession("REQ", sessionId)).toBe(false);
  });

  // The regression: a session that outlived the server exists only in tmux — no live pty, and for
  // codex/antigravity no cold-resume id either, since `tmux new-session -A` reattaches the running
  // program instead.
  it("is true for a tmux-only reattach", () => {
    const { sessionId } = resolveReattachableId("REQ", { hasLivePty: false, tmuxAlive: true, canResume: false }, () => "FRESH");
    expect(isContinuingSession("REQ", sessionId)).toBe(true);
  });

  it("is true for every other way a session continues", () => {
    const mintFresh = () => "FRESH";
    const claude = resolveSession("REQ", facts({ tmuxAlive: true }), mintFresh);
    expect(isContinuingSession("REQ", claude.sessionId)).toBe(true);
    expect(isContinuingSession("REQ", resolveSession("REQ", facts({ hasLivePty: true }), mintFresh).sessionId)).toBe(true);
    expect(isContinuingSession("REQ", resolveSession("REQ", facts({ onDisk: true }), mintFresh).sessionId)).toBe(true);
    expect(isContinuingSession("REQ", resolveReattachableId("REQ", { hasLivePty: false, tmuxAlive: false, canResume: true }, mintFresh).sessionId)).toBe(true);
  });
});

// A launcher connection needs SOMETHING to run: an existing process to reattach to, a
// configured launcher at the requested index, or the "new terminal" shell button.
describe("canStartLauncher", () => {
  const facts = (over = {}) => ({ hasLivePty: false, tmuxAlive: false, hasLauncher: false, isShell: false, ...over });

  it("refuses when there is nothing to reattach and no launcher at that index", () => {
    expect(canStartLauncher(facts())).toBe(false);
  });

  it("allows a reattach even when the index names no launcher", () => {
    // The pty already IS the chosen program, so the index is irrelevant.
    expect(canStartLauncher(facts({ hasLivePty: true }))).toBe(true);
    expect(canStartLauncher(facts({ tmuxAlive: true }))).toBe(true);
  });

  it("allows a fresh spawn of a configured launcher", () => {
    expect(canStartLauncher(facts({ hasLauncher: true }))).toBe(true);
  });

  it("allows the shell button, which has no configured index", () => {
    expect(canStartLauncher(facts({ isShell: true }))).toBe(true);
  });
});

// Which endpoint a LIVE session may be handed to. `?session=` is only what the browser last held,
// so a cell relaunched as another agent can carry its old id into the new endpoint — and nothing
// downstream looks before reattaching. Observed on 2026-09-22: a cell launched as codex came back
// holding the claude session already open in another cell, the same id in both.
describe("servesAgent", () => {
  it("refuses a live session belonging to another agent", () => {
    expect(servesAgent("claude", "codex")).toBe(false);
    expect(servesAgent("codex", "claude")).toBe(false);
    expect(servesAgent("grok", "antigravity")).toBe(false);
  });

  it("serves a session running the agent that asked for it", () => {
    expect(servesAgent("codex", "codex")).toBe(true);
    expect(servesAgent("claude", "claude")).toBe(true);
  });

  it("serves anything when the caller names no agent, which is the launcher", () => {
    // A launcher runs the user's own command line and reattaches whatever is in the pane on
    // purpose — the index is ignored on a reattach, because the pty already IS the program.
    expect(servesAgent("claude", undefined)).toBe(true);
    expect(servesAgent("codex", undefined)).toBe(true);
  });

  it("serves a pane whose program is not an agent at all", () => {
    // A shell, a pager, a build. None of these say whose session it is, and refusing on a guess
    // would break reattaching a session that is perfectly good.
    expect(servesAgent("bash", "codex")).toBe(true);
    expect(servesAgent("zsh", "claude")).toBe(true);
    expect(servesAgent("node", "codex")).toBe(true);
  });

  it("serves when the program cannot be read", () => {
    // tmux answers null for a session it cannot inspect; a restart leaves nothing recorded.
    expect(servesAgent(null, "codex")).toBe(true);
    expect(servesAgent(undefined, "codex")).toBe(true);
    expect(servesAgent("", "codex")).toBe(true);
  });

  it("feeds the resolvers: a refused session mints a fresh id rather than reattaching", () => {
    // The composition is the fix. servesAgent only answers false; it is resolveReattachableId
    // turning that into a NEW id that gives the user the session they actually asked for.
    const claudesId = "11111111-1111-4111-8111-111111111111";
    const hasLivePty = servesAgent("claude", "codex"); // a live claude pty, asked for as codex
    expect(resolveReattachableId(claudesId, { hasLivePty, tmuxAlive: false, canResume: false }, mint)).toEqual({
      reattachId: null,
      sessionId: FIXED,
    });
  });

  it("still reattaches that same session to the endpoint it belongs to", () => {
    const claudesId = "11111111-1111-4111-8111-111111111111";
    const hasLivePty = servesAgent("claude", "claude");
    expect(resolveReattachableId(claudesId, { hasLivePty, tmuxAlive: false, canResume: false }, mint)).toEqual({
      reattachId: claudesId,
      sessionId: claudesId,
    });
  });
});
