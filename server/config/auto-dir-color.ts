// ── LOCAL FORK ────────────────────────────────────────────────────────────────────────
// A colour for every repository, without anyone writing one.
//
// In this workspace a cell's colour says WHICH REPOSITORY it belongs to. That only works if every
// repository has one, and a `.mulmoterminal.json` written by hand does not exist for the repo
// cloned this morning — its cells came up grey, next to the ones that were configured.
//
// So a directory that names no colour of its own takes its repository's:
//
//   1. the colours its own working tree's root names (a cell opened in `repo/apps/mobile`),
//   2. else the ones the repository's main checkout names (a linked worktree of a coloured repo),
//   3. else a hue reserved for the repository the first time it is seen, kept from then on.
//
// A colour somebody WROTE always wins — this only ever fills a blank. What the file said stays
// what `loadDirConfig` reports, the way an auto-detected icon stays out of it (#1428): a worktree
// inherits what was written, never what was filled in here.
// ──────────────────────────────────────────────────────────────────────────────────────
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DirChrome } from "../../common/dirChrome.js";
import { parseHex } from "../../common/chromeFromColor.js";
import { isRecord } from "../../common/isRecord.js";
import { mulmoterminalHome } from "../infra/mulmoterminal-home.js";

const COLOR_KEYS = ["badgeColor", "headerColor", "headerTextColor", "cellColor", "cellBorderColor", "dotColor", "buttonColor"] as const;

/** The seven chrome colours plus the badge label — everything this module can fill in. */
export type DirIdentity = Pick<DirChrome, "name" | (typeof COLOR_KEYS)[number]>;

const hasColors = (chrome: DirIdentity): boolean => COLOR_KEYS.some((key) => chrome[key] !== null);

// ── the palette ───────────────────────────────────────────────────────────────────────

// One hue, five roles: a deep header and border, with the badge and the idle dot lifted to a pale
// tint of the same hue. Saturation stays under 45% on purpose — the session-state colours
// (running, done, waiting …) are all above 70%, so a cell reads "muted = where, vivid = what is
// happening" even when the two share a hue. The header sits above the panel's own L16 and the
// border above its L24; darker than that and the colour disappears into the app.
const ROLE_SL = {
  headerColor: [0.32, 0.21],
  headerTextColor: [0.14, 0.86],
  badgeColor: [0.4, 0.66],
  cellBorderColor: [0.28, 0.33],
  dotColor: [0.44, 0.6],
} as const;

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const rgb = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][Math.floor(sector) % 6] ?? [0, 0, 0];
  const floor = lightness - chroma / 2;
  return `#${rgb
    .map((channel) =>
      Math.round((channel + floor) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The colours a repository with no config gets, from its reserved hue. The cell body and the
 *  header buttons are left to the theme, as they are in the hand-written configs this matches. */
export function chromeForHue(hue: number): Omit<DirIdentity, "name"> {
  const at = ([saturation, lightness]: readonly [number, number]): string => hslToHex(hue, saturation, lightness);
  return {
    headerColor: at(ROLE_SL.headerColor),
    headerTextColor: at(ROLE_SL.headerTextColor),
    badgeColor: at(ROLE_SL.badgeColor),
    cellBorderColor: at(ROLE_SL.cellBorderColor),
    dotColor: at(ROLE_SL.dotColor),
    cellColor: null,
    buttonColor: null,
  };
}

// Below this a colour is a grey with a rounding error, and its "hue" is noise.
const MIN_SATURATION = 0.08;

/** The hue of a `#rrggbb` colour in degrees, or null for one too grey to have one. */
export function hueOfHex(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return null;
  const lightness = (max + min) / 2;
  if (delta / (1 - Math.abs(2 * lightness - 1)) < MIN_SATURATION) return null;
  let sector: number;
  if (max === r) sector = ((g - b) / delta) % 6;
  else if (max === g) sector = (b - r) / delta + 2;
  else sector = (r - g) / delta + 4;
  return Math.round((sector * 60 + 360) % 360);
}

// Twelve hues, 30° apart: at this saturation anything closer reads as the same colour.
const CANDIDATE_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** The candidate furthest from every hue already in use — so a new repository lands as far from
 *  its neighbours as the wheel still allows. Ties go to the earlier candidate, which keeps the
 *  answer the same on every machine that has seen the same repositories. */
export function pickHue(taken: readonly number[]): number {
  let best = CANDIDATE_HUES[0] ?? 0;
  let bestGap = -1;
  for (const candidate of CANDIDATE_HUES) {
    const gap = taken.length ? Math.min(...taken.map((hue) => hueDistance(candidate, hue))) : 360;
    if (gap > bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

// ── which repository a directory belongs to ───────────────────────────────────────────

export interface RepoFamily {
  /** What identifies the repository across all its working trees: its git directory. */
  key: string;
  /** The root of the working tree `dir` is in. */
  toplevel: string;
  /** The repository's main checkout — null for a bare repository, which has none. */
  mainCheckout: string | null;
  /** What to call the repository when nothing names it. */
  repoName: string;
}

const GITDIR_PREFIX = "gitdir:";

const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

// A linked worktree's `.git` is a file holding `gitdir: <git dir>/worktrees/<name>`; a submodule's
// is a file too, pointing at its own git dir with no `worktrees` segment.
function familyFromGitFile(toplevel: string, file: string): RepoFamily | null {
  let line: string;
  try {
    line = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  if (!line.startsWith(GITDIR_PREFIX)) return null;
  const gitDir = path.resolve(toplevel, line.slice(GITDIR_PREFIX.length).trim());
  const worktreesDir = path.dirname(gitDir);
  if (path.basename(worktreesDir) !== "worktrees") return { key: gitDir, toplevel, mainCheckout: toplevel, repoName: path.basename(toplevel) };
  const commonDir = path.dirname(worktreesDir);
  // `<checkout>/.git` has a checkout beside it; anything else (`<root>/.bare`) is a bare repository.
  const mainCheckout = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
  return { key: commonDir, toplevel, mainCheckout, repoName: path.basename(path.dirname(commonDir)) };
}

/** The repository `dir` is in, read from the filesystem — no git process, because this runs on
 *  the path every cell polls. Null outside a repository. */
export function repoFamilySync(dir: string): RepoFamily | null {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, ".git");
    if (existsSync(dotGit)) {
      if (!isDirectory(dotGit)) return familyFromGitFile(current, dotGit);
      // A real git directory has a HEAD. A stray empty `.git` folder is not a repository, and
      // must not make everything beneath it one.
      if (existsSync(path.join(dotGit, "HEAD"))) return { key: dotGit, toplevel: current, mainCheckout: current, repoName: path.basename(current) };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── the reservations ──────────────────────────────────────────────────────────────────

// Append-only, one JSON object per line, for the reason worktree-env-log.ts is: this home is
// shared by every server on the machine, and a read-merge-write loses whichever of two finishes
// first.
//
//   auto  a hue this module reserved for a repository. The first line for a repository wins and
//         it never moves — delete the line to have the hue picked again.
//   seen  a hue a directory's own config names, recorded so the next reservation can steer
//         clear of it even when that repository has no cell open. The LAST line for a directory
//         wins, and a directory that no longer exists counts for nothing — so recolouring a
//         project, or removing a worktree, stops holding its old hue against everyone else.
const STORE_FILE = "repo-colors.jsonl";

type HueEntry = { kind: "auto"; repo: string; hue: number } | { kind: "seen"; repo: string; dir: string; hue: number };

function parseEntry(line: string): HueEntry | null {
  try {
    const raw: unknown = JSON.parse(line);
    if (!isRecord(raw) || typeof raw.repo !== "string" || typeof raw.hue !== "number") return null;
    if (raw.kind === "auto") return { kind: "auto", repo: raw.repo, hue: raw.hue };
    if (raw.kind === "seen" && typeof raw.dir === "string") return { kind: "seen", repo: raw.repo, dir: raw.dir, hue: raw.hue };
    return null;
  } catch {
    return null;
  }
}

const parseEntries = (text: string): HueEntry[] => text.split("\n").flatMap((line) => parseEntry(line) ?? []);

const storePath = (): string => path.join(mulmoterminalHome(), STORE_FILE);

// Reservations reach the disk only once the server says so at startup. Until then they live in
// this array: anything else that loads a config inside a repository — a test with a temp clone,
// a one-off script — must not leave reservations for directories that are about to be deleted
// in the real home, where each one would push the next real repository further round the wheel.
let persisted = false;
const inMemory: HueEntry[] = [];

/** Keep reservations in `repo-colors.jsonl` from now on. Called once, by the server. */
export function persistRepoColors(on = true): void {
  persisted = on;
}

// Every cell polls its directory's config, so the file is parsed again only when it has changed.
let cached: { stamp: string; entries: HueEntry[] } | null = null;

function readEntries(): HueEntry[] {
  if (!persisted) return inMemory;
  try {
    const file = storePath();
    if (!existsSync(file)) return [];
    const { mtimeMs, size } = statSync(file);
    const stamp = `${file} ${mtimeMs} ${size}`;
    if (cached?.stamp !== stamp) cached = { stamp, entries: parseEntries(readFileSync(file, "utf8")) };
    return cached.entries;
  } catch {
    return [];
  }
}

// A reservation that could not be written still colours the cell for this run; it is simply
// worked out again next time, which lands on the same hue unless the neighbours changed.
function appendEntry(entry: HueEntry): void {
  if (!persisted) {
    inMemory.push(entry);
    return;
  }
  try {
    const file = storePath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `\n${JSON.stringify(entry)}`, "utf8");
  } catch {
    // Nothing to do: see above.
  }
}

/** The hue each directory's config names right now: the last line per directory, minus the
 *  directories that are gone. */
function currentlySeen(entries: readonly HueEntry[]): { repo: string; hue: number }[] {
  const latest = new Map<string, { repo: string; hue: number }>();
  for (const entry of entries) if (entry.kind === "seen") latest.set(entry.dir, { repo: entry.repo, hue: entry.hue });
  return [...latest].filter(([dir]) => existsSync(dir)).map(([, seen]) => seen);
}

// The hue last recorded per directory by THIS process, so the polled path writes only on a change.
const lastSeen = new Map<string, number>();

function noteSeen(repo: string, dir: string, hue: number): void {
  if (lastSeen.get(dir) === hue) return;
  // First sight of this directory since startup: it may already be on record from an earlier run.
  if (!lastSeen.has(dir)) {
    const recorded = readEntries().findLast((entry) => entry.kind === "seen" && entry.dir === dir);
    if (recorded?.hue === hue) {
      lastSeen.set(dir, hue);
      return;
    }
  }
  appendEntry({ kind: "seen", repo, dir, hue });
  lastSeen.set(dir, hue);
}

const mostCommon = (hues: readonly number[]): number | null => {
  const counts = new Map<number, number>();
  hues.forEach((hue) => counts.set(hue, (counts.get(hue) ?? 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** The hue for a repository none of whose relatives on this directory's path named a colour.
 *
 *  A repository whose OTHER working trees name one already has a colour — a bare repository's
 *  worktrees have no main checkout to borrow from, but they are still one family — so that hue is
 *  used as it stands. Otherwise: the hue the repository already holds, else a new one clear of
 *  every hue any repository uses, written down so it never moves afterwards. */
function hueForRepo(repo: string): number {
  const entries = readEntries();
  const seen = currentlySeen(entries);
  const familyHue = mostCommon(seen.filter((entry) => entry.repo === repo).map((entry) => entry.hue));
  if (familyHue !== null) return familyHue;
  // The FIRST reservation wins, so two servers racing to colour a new repository agree on
  // whichever line landed first instead of each keeping its own.
  const held = entries.find((entry) => entry.kind === "auto" && entry.repo === repo);
  if (held) return held.hue;
  const reserved = entries.filter((entry) => entry.kind === "auto").map((entry) => entry.hue);
  const hue = pickHue([...seen.map((entry) => entry.hue), ...reserved]);
  appendEntry({ kind: "auto", repo, hue });
  return hue;
}

// ── filling the blank ─────────────────────────────────────────────────────────────────

const identityOf = (chrome: DirIdentity): DirIdentity => ({
  name: chrome.name,
  badgeColor: chrome.badgeColor,
  headerColor: chrome.headerColor,
  headerTextColor: chrome.headerTextColor,
  cellColor: chrome.cellColor,
  cellBorderColor: chrome.cellBorderColor,
  dotColor: chrome.dotColor,
  buttonColor: chrome.buttonColor,
});

// The label for a directory nobody named: the repository for its main checkout, the folder for
// any other working tree — the colour already says which repository, so the badge is free to
// say which checkout.
const defaultName = (family: RepoFamily): string => (family.toplevel === family.mainCheckout ? family.repoName : path.basename(family.toplevel));

/** The name and colours `cwd`'s cells show: its own where it named them, its repository's where
 *  it did not. `own` is what its config files said; `load` reads another directory's. */
export function dirIdentityFor(cwd: string, own: DirIdentity, load: (dir: string) => DirIdentity): DirIdentity {
  const family = repoFamilySync(cwd);
  if (!family) return identityOf(own);
  const here = path.resolve(cwd);
  if (hasColors(own)) {
    const hue = hueOfHex(own.headerColor ?? own.badgeColor ?? "");
    if (hue !== null) noteSeen(family.key, here, hue);
    return identityOf(own);
  }
  // A subdirectory answers to its working tree's root; a linked worktree's root answers to the
  // main checkout. Only the root lends its NAME — a worktree called after its repository would
  // be indistinguishable from the main checkout sitting next to it.
  const top = here === family.toplevel ? null : load(family.toplevel);
  const main = family.mainCheckout !== null && family.mainCheckout !== family.toplevel ? load(family.mainCheckout) : null;
  const name = own.name ?? top?.name ?? defaultName(family);
  const donor = [top, main].find((candidate) => candidate !== null && hasColors(candidate));
  if (donor) return { ...identityOf(donor), name };
  return { ...chromeForHue(hueForRepo(family.key)), name };
}
