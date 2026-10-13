// Format an absolute working directory for the compact cell header: anchor on the
// home dir (~), and if it's still too long keep the TAIL (the most specific part)
// and drop the front behind an ellipsis — e.g. "…hoge/foo/bar".

export function homeRelative(cwd: string, home: string | null): string {
  if (!home) return cwd;
  // Windows paths use "\" and are case-insensitive (incl. the drive letter).
  const windows = home.includes("\\") || /^[a-zA-Z]:/.test(home);
  const matches = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (matches(cwd, home)) return "~";
  // cwd must continue with a separator right after the home prefix (so /Users/me
  // doesn't match /Users/mehmet).
  const next = cwd.charAt(home.length);
  if ((next === "/" || next === "\\") && matches(cwd.slice(0, home.length), home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

// Keep the last `max` chars (the tail), prefixed with "…" when truncated.
export function truncateFront(s: string, max: number): string {
  return s.length <= max ? s : `…${s.slice(s.length - (max - 1))}`;
}

// A git worktree kept under a `wt/` root — the common `<repo>/wt/<type>/<name>` layout — shows the
// branch, not the road to it. "~/AidaNote/wt/feat/act-formulation" is 34 characters of which only
// the last 20 differ between cells, and the header truncates from the FRONT, so the part that
// identifies the cell is exactly the part at risk.
//
// `wt` and not `worktrees`: that other name is MulmoTerminal's own managed layout, which
// worktreeLabel already renders as "<repo> (<task>)". Shortening it here as well would leave the
// two disagreeing about the same path.
//
// The LAST `wt` segment wins, and a path ENDING in `wt` is left alone — there is no branch after
// it to show, and returning "" would lose the cell's only location cue.
export function worktreeTail(shown: string): string {
  const parts = shown.split(/[/\\]/u);
  const at = parts.lastIndexOf("wt");
  if (at < 0 || at === parts.length - 1) return shown;
  return parts.slice(at + 1).join(shown.includes("\\") ? "\\" : "/");
}

export function formatCwd(cwd: string | null, home: string | null, max = 30): string {
  if (!cwd) return "";
  return truncateFront(worktreeTail(homeRelative(cwd, home)), max);
}

// A managed worktree's cwd looks like .../worktrees/<repo>-<8hex>/<task> (see the
// server's worktreesRoot). For those, the long managed path is noise in the header
// — surface "<repo> (<task>)" instead. Returns null for any non-worktree path.
const MANAGED_DIR = /^(.+)-[0-9a-f]{8}$/;
export function worktreeLabel(cwd: string | null): { repo: string; task: string } | null {
  if (!cwd) return null;
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  const i = parts.indexOf("worktrees");
  const dir = parts[i + 1];
  const task = parts[i + 2];
  if (i < 0 || !dir || !task) return null;
  const m = MANAGED_DIR.exec(dir);
  return m?.[1] === undefined ? null : { repo: m[1], task };
}
