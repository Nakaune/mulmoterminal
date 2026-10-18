// ── LOCAL FORK ────────────────────────────────────────────────────────────────────────
// Where a clicked terminal path opens when the browser is NOT on the machine the server runs
// on. This fork's click reveals the path in the OS file manager (see terminalFilePathLinkProvider)
// — a window that opens on the SERVER's desktop. Viewed from a second PC or a phone, that is a
// click that does nothing you can see, so there the path opens inside the app instead.
//
// The in-app routes were the reason the fork left them in the first place: they are scoped to a
// serving base, and a path outside the session's cwd — a sibling worktree, `~/.claude/…` — died
// on "path escapes the serving root". The base is a request parameter, though, and the browse
// routes accept any existing directory as one. So the path is resolved HERE into a base that
// contains it, rather than handed over relative to a cwd it may not be under.
// ──────────────────────────────────────────────────────────────────────────────────────
import { pathWithinCwd } from "./pathWithinCwd";

// The page you are reading is the evidence of where you sit, the same way loopbackLink reads it:
// the desktop is served from `localhost`, the tunnelled browser from `127.0.0.1`, a phone from the
// machine's Tailscale name. `localhost` is the only spelling that means "the file manager would
// open in front of me", so it is the only one that keeps the reveal.
const DESKTOP_HOST = "localhost";

export function isViewedRemotely(viewedHost: string): boolean {
  return viewedHost !== DESKTOP_HOST;
}

/** A serving base and the path under it — the `?cwd=` / `?path=` pair the file routes take. */
export interface ServingTarget {
  base: string;
  rel: string;
}

// `token` as an absolute path on the server's disk, or null when that cannot be worked out
// here: a `~` with no home known yet, or a cwd that is not a POSIX path (pathWithinCwd already
// answers for a Windows cwd, and nothing in this fork runs on one).
function absolutePathOf(token: string, cwd: string, home: string | null): string | null {
  if (!cwd.startsWith("/")) return null;
  let joined: string;
  if (token === "~" || token.startsWith("~/")) {
    if (!home) return null;
    joined = `${home}${token.slice(1)}`;
  } else {
    joined = token.startsWith("/") ? token : `${cwd}/${token}`;
  }
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.length ? `/${segments.join("/")}` : null;
}

/** The base to serve a clicked path from, and the path's place under it.
 *
 *  A session's cwd is preferred — the clicking session's own first, then any other live one —
 *  because the raw route (images, PDFs, HTML) serves from nowhere else. Failing that the file's
 *  own folder is the base: enough for everything the browse routes answer, which is text. */
export function servingTargetFor(token: string, cwd: string, home: string | null, sessionCwds: readonly string[]): ServingTarget {
  const abs = absolutePathOf(token, cwd, home);
  // Unresolvable here: hand it over the way upstream does and let the server answer for it.
  if (abs === null) return { base: cwd, rel: token };
  // Longest first, so the most specific session directory wins over one of its parents.
  const others = [...sessionCwds].sort((a, b) => b.length - a.length);
  for (const base of [cwd, ...others]) {
    const rel = pathWithinCwd(abs, base);
    if (rel !== null) return { base, rel };
  }
  const cut = abs.lastIndexOf("/");
  return { base: abs.slice(0, cut) || "/", rel: abs.slice(cut + 1) };
}
