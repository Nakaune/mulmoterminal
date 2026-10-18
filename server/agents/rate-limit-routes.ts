// The two ends of the gauge (#387): where the probe reports, and where the browser reads.
//
// No origin check of its own — `sameOriginGuard` already gates every POST centrally, which is
// exactly the arrangement that file argues for ("a route added tomorrow is covered by default
// rather than by memory"). The probe's own report carries no Origin and comes from loopback, which
// that predicate allows.
//
// The refresh is a POST and not a side effect on the GET, for the reason same-origin-guard.ts
// states outright: safe methods are not gated, so a cross-site `<img src=…/api/rate-limits>` would
// otherwise spend the user's quota on a probe. The GET stays a pure read.
import type { Express } from "express";
import { readClaudeStatus } from "./statusline.js";
import { currentClaudeLimits } from "./rate-limit-store.js";
import type { ProbeState } from "./rate-limit-store.js";
import type { RateLimitSnapshot, RateLimitStore } from "./rate-limit-store.js";
import type { RateLimits, ScopedRateLimitWindow } from "../../common/rateLimits.js";

export interface RateLimitRouteDeps {
  store: RateLimitStore;
  /** Re-read Codex's rollout from disk. Free, so it happens on every refresh. */
  refreshCodex: () => void;
  /** Spawn the Claude probe. Only called when the store says it is worth a query. */
  startProbe: () => void;
  /** Whether `claude` could be launched right now — a PATH lookup, not a spawn. Asked on every
   *  poll so the "not installed" state can clear itself when one appears (#1019). */
  claudeAvailable: () => boolean;
  /** Claude's per-model weekly windows, re-read from disk. Free, like the Codex refresh, so it
   *  happens on every read rather than being held in the store — the store's job is the readings
   *  a probe had to be spent on. */
  claudeScopedWindows: (now_ms: number) => ScopedRateLimitWindow[];
  now_ms: () => number;
}

export function mountRateLimitRoutes(app: Express, deps: RateLimitRouteDeps): void {
  // Written by the statusLine given to the probe, which pipes Claude Code's status payload here.
  app.post("/api/rate-limits", (req, res) => {
    deps.store.reportClaudeStatus(readClaudeStatus(req.body), deps.now_ms());
    res.json({ ok: true });
  });

  // The browser says "I am looking at this". That permission is what lets a probe run at all.
  app.post("/api/rate-limits/refresh", (_req, res) => {
    const now = deps.now_ms();
    deps.store.noteAsked(now);
    deps.refreshCodex();
    deps.store.setClaudeAvailable(deps.claudeAvailable());
    if (deps.store.wantsProbe(now)) {
      deps.store.setProbeInFlight(true);
      // Belt and braces. `startRateLimitProbe` reports its own setup failures rather than
      // throwing, but the flag it would strand is set HERE — so this route does not get to
      // depend on that promise being kept by whatever is wired in next.
      try {
        deps.startProbe();
      } catch {
        deps.store.setProbeInFlight(false);
      }
    }
    res.json(snapshotBody(deps.store.snapshot(), deps.store.isProbing(), deps.store.probeState(), now, deps.claudeScopedWindows(now)));
  });

  app.get("/api/rate-limits", (_req, res) => {
    const now = deps.now_ms();
    res.json(snapshotBody(deps.store.snapshot(), deps.store.isProbing(), deps.store.probeState(), now, deps.claudeScopedWindows(now)));
  });
}

// An agent with nothing to report is simply absent, so the client can tell "no data" from "0%".
// An agent that is not installed at all reaches this the same way — there is no separate
// "unavailable" state to render, because there is nothing useful to say about a tool the user
// does not use.
// `probing` is not decoration: a Claude probe takes most of a minute, so a client polling on its
// normal interval paints Codex alone and keeps that half-gauge on screen for minutes. Saying a
// reading is on its way is what lets the client wait for it instead.
// `claudeProbe` carries WHY the Claude half is missing, when it is. Without it the gauge cannot
// tell "not measured yet" from "cannot be measured here", and #1011 showed what that costs: a
// probe loop ran every 90 seconds for half an hour, spending the very budget the gauge reports,
// with nothing on screen to hint at it.
// `claudeProbeStall` narrows the one state that has more than one cause worth acting on. Sent as
// the server's own word for it rather than the probe's screen: the screen stays on this machine
// (probe-stall.ts), and only the verdict crosses to the browser.
//
// Claude's windows go through `currentClaudeLimits`, which drops a reading too old to vouch for.
// The client needs no rule of its own for that — with no windows to draw it already explains the
// gap from `claudeProbe` (#1293).
//
// The per-model windows are attached to the Claude reading rather than sent beside it, and only
// when there IS one: they are the same account's budget seen a second way, so `5h 9% · 7d 45% ·
// fable 74%` is one row that reads left to right. Sending them when the account windows are
// missing would put a lone percentage next to "claude usage n/a" — a figure with nothing to say
// what it is a fraction of, beside a line saying we cannot see the usage.
const withScoped = (limits: RateLimits | null, scoped: readonly ScopedRateLimitWindow[]): RateLimits | null =>
  limits && scoped.length ? { ...limits, scoped: [...scoped] } : limits;

const snapshotBody = (snapshot: RateLimitSnapshot, probing: boolean, state: ProbeState, now_ms: number, scoped: readonly ScopedRateLimitWindow[]) => ({
  claude: withScoped(currentClaudeLimits(snapshot, now_ms), scoped),
  codex: snapshot.codex?.limits ?? null,
  probing,
  claudeProbe: state.kind,
  claudeProbeStall: state.kind === "no-report" ? state.stall : undefined,
});
