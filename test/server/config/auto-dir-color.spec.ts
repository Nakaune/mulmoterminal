// @vitest-environment node
// LOCAL FORK: a directory that names no colour takes its repository's (auto-dir-color.ts). What is
// pinned here is the promise a user would notice breaking — every repository gets a colour, the
// same one each time, a different one from its neighbours, and never over one somebody wrote.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "../../support/tempDir.js";
import { chromeForHue, hueOfHex, persistRepoColors, pickHue, repoFamilySync } from "../../../server/config/auto-dir-color";
import { loadDirConfig, publicDirConfig } from "../../../server/config/dir-config";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = makeTempDir("mt-autocolor-");
  dirs.push(dir);
  return dir;
};

let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env.MULMOTERMINAL_HOME;
  home = tempDir();
  process.env.MULMOTERMINAL_HOME = home;
  persistRepoColors(true);
});
afterEach(() => {
  persistRepoColors(false);
  if (savedHome === undefined) delete process.env.MULMOTERMINAL_HOME;
  else process.env.MULMOTERMINAL_HOME = savedHome;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

// A main checkout as git leaves it on disk — no git process, which is how the code reads it too.
function repo(name: string, config: Record<string, unknown> | null = null): string {
  const dir = path.join(tempDir(), name);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (config) writeFileSync(path.join(dir, ".mulmoterminal.json"), JSON.stringify(config));
  return dir;
}

// A linked worktree of `main`: its `.git` is a file pointing into the main checkout's git dir.
function linkedWorktree(main: string, name: string): string {
  const dir = path.join(tempDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", name)}\n`);
  return dir;
}

const storeLines = (): string[] => {
  try {
    return readFileSync(path.join(home, "repo-colors.jsonl"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

describe("the palette", () => {
  // The same five values AidaNote's own generator writes for its worktrees (hue 178), so a
  // repository coloured here and one coloured there are visibly the same family of design.
  it("builds a deep header with a pale badge and dot of the same hue", () => {
    expect(chromeForHue(178)).toEqual({
      headerColor: "#244746",
      headerTextColor: "#d6e0e0",
      badgeColor: "#86cbc9",
      cellBorderColor: "#3d6c6a",
      dotColor: "#6cc6c3",
      cellColor: null,
      buttonColor: null,
    });
  });

  it("reads a colour's hue, and refuses to name one for a grey", () => {
    expect(hueOfHex("#244746")).toBe(178);
    expect(hueOfHex("#502f26")).toBe(13);
    expect(hueOfHex("#666666")).toBeNull();
    expect(hueOfHex("not a colour")).toBeNull();
  });

  it("picks the hue furthest from the ones in use", () => {
    expect(pickHue([])).toBe(0);
    // Teal and clay taken: the widest gap on the wheel is around 270.
    expect(pickHue([178, 13])).toBe(270);
    expect(pickHue([178, 13, 270])).toBe(90);
  });
});

describe("which repository a directory belongs to", () => {
  it("finds the main checkout from inside it", () => {
    const main = repo("alpha");
    mkdirSync(path.join(main, "apps", "mobile"), { recursive: true });
    expect(repoFamilySync(path.join(main, "apps", "mobile"))).toEqual({
      key: path.join(main, ".git"),
      toplevel: main,
      mainCheckout: main,
      repoName: "alpha",
    });
  });

  it("gives a linked worktree its main checkout's identity", () => {
    const main = repo("alpha");
    const tree = linkedWorktree(main, "task-1");
    expect(repoFamilySync(tree)).toEqual({ key: path.join(main, ".git"), toplevel: tree, mainCheckout: main, repoName: "alpha" });
  });

  // The bare + worktrees layout: there is no main checkout to borrow from, only a shared git dir.
  it("treats a bare repository's worktrees as one family with no main checkout", () => {
    const root = path.join(tempDir(), "beta");
    const tree = path.join(root, "wt", "feat");
    mkdirSync(tree, { recursive: true });
    writeFileSync(path.join(tree, ".git"), `gitdir: ${path.join(root, ".bare", "worktrees", "feat")}\n`);
    expect(repoFamilySync(tree)).toEqual({ key: path.join(root, ".bare"), toplevel: tree, mainCheckout: null, repoName: "beta" });
  });

  // An empty `.git` folder is not a repository, and must not turn everything under it into one.
  it("ignores a stray .git directory with no HEAD", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "inner"));
    expect(repoFamilySync(path.join(dir, "inner"))).toBeNull();
  });
});

describe("a directory that names no colour", () => {
  it("gets its repository's name and a colour, and keeps that colour", () => {
    const main = repo("alpha");
    const first = publicDirConfig(main);
    expect(first.name).toBe("alpha");
    expect(first.headerColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(first.badgeColor).not.toBe(first.headerColor);
    expect(publicDirConfig(main)).toEqual(first);
    // One reservation, written once — not one per poll.
    expect(storeLines()).toHaveLength(1);
  });

  it("gives two repositories colours a reader can tell apart", () => {
    const hueA = hueOfHex(publicDirConfig(repo("alpha")).headerColor ?? "");
    const hueB = hueOfHex(publicDirConfig(repo("beta")).headerColor ?? "");
    if (hueA === null || hueB === null) throw new Error("expected both repositories to be coloured");
    const gap = Math.min(Math.abs(hueA - hueB), 360 - Math.abs(hueA - hueB));
    expect(gap).toBeGreaterThanOrEqual(90);
  });

  // A hue somebody wrote is steered clear of even though that repository reserved nothing.
  it("keeps clear of a colour another repository's config names", () => {
    publicDirConfig(repo("teal", { headerColor: "#244746" }));
    const hue = hueOfHex(publicDirConfig(repo("fresh")).headerColor ?? "");
    if (hue === null) throw new Error("expected the fresh repository to be coloured");
    expect(Math.min(Math.abs(hue - 178), 360 - Math.abs(hue - 178))).toBeGreaterThanOrEqual(90);
  });

  // The record is of what configs say NOW. A project that was recoloured must not go on holding
  // its old hue against every repository that arrives later.
  it("stops avoiding a hue once the config that named it has changed", () => {
    const moved = repo("moved", { headerColor: "#244746" });
    publicDirConfig(moved);
    writeFileSync(path.join(moved, ".mulmoterminal.json"), JSON.stringify({ headerColor: "#502f26" }));
    publicDirConfig(moved);
    // Only clay (13) is in use now, so the far side of the wheel — where teal was — is free again.
    expect(hueOfHex(publicDirConfig(repo("fresh")).headerColor ?? "")).toBe(180);
  });

  it("stops avoiding a hue once the directory that named it is gone", () => {
    const gone = repo("gone", { headerColor: "#244746" });
    publicDirConfig(gone);
    rmSync(gone, { recursive: true, force: true });
    expect(hueOfHex(publicDirConfig(repo("fresh")).headerColor ?? "")).toBe(0);
  });

  // A bare repository has no main checkout to borrow from, but its worktrees are one family: an
  // unconfigured one takes the hue its siblings name rather than a new reservation.
  it("gives a bare repository's unconfigured worktree the hue its siblings name", () => {
    const root = path.join(tempDir(), "beta");
    const worktree = (name: string, config: Record<string, unknown> | null): string => {
      const dir = path.join(root, "wt", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(root, ".bare", "worktrees", name)}\n`);
      if (config) writeFileSync(path.join(dir, ".mulmoterminal.json"), JSON.stringify(config));
      return dir;
    };
    publicDirConfig(worktree("configured", { headerColor: "#244746" }));
    const bare = publicDirConfig(worktree("plain", null));
    expect(bare.headerColor).toBe("#244746");
    expect(bare.name).toBe("plain");
    expect(storeLines().filter((line) => line.includes('"auto"'))).toHaveLength(0);
  });

  it("shares the colour across the repository's working trees, each under its own name", () => {
    const main = repo("alpha");
    const tree = linkedWorktree(main, "task-1");
    const mainConfig = publicDirConfig(main);
    const treeConfig = publicDirConfig(tree);
    expect(treeConfig.headerColor).toBe(mainConfig.headerColor);
    expect(treeConfig.name).toBe("task-1");
  });

  it("takes the colours its main checkout wrote", () => {
    const main = repo("alpha", { name: "Alpha", headerColor: "#502f26", badgeColor: "#d5907b" });
    const tree = publicDirConfig(linkedWorktree(main, "task-1"));
    expect(tree.headerColor).toBe("#502f26");
    expect(tree.badgeColor).toBe("#d5907b");
    expect(tree.name).toBe("task-1");
  });

  it("answers for a subdirectory with its working tree's root, name included", () => {
    const main = repo("alpha", { name: "Alpha", headerColor: "#502f26" });
    mkdirSync(path.join(main, "apps", "mobile"), { recursive: true });
    const sub = publicDirConfig(path.join(main, "apps", "mobile"));
    expect(sub.headerColor).toBe("#502f26");
    expect(sub.name).toBe("Alpha");
  });
});

// Only the server turns the file on. A test elsewhere that loads a config inside a temp clone
// would otherwise leave reservations for deleted directories in the real home.
describe("before the server enables the store", () => {
  it("colours the repository without writing anything", () => {
    persistRepoColors(false);
    const first = publicDirConfig(repo("alpha"));
    expect(first.headerColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(storeLines()).toHaveLength(0);
  });
});

describe("what stays untouched", () => {
  it("leaves a colour somebody wrote exactly as written", () => {
    const main = repo("alpha", { headerColor: "#123456" });
    const config = publicDirConfig(main);
    expect(config.headerColor).toBe("#123456");
    // The other six stay unset: filling them in around a hand-picked header would mix two schemes.
    expect(config.badgeColor).toBeNull();
    expect(config.name).toBeNull();
  });

  it("does nothing outside a repository", () => {
    const dir = tempDir();
    expect(publicDirConfig(dir).headerColor).toBeNull();
    expect(publicDirConfig(dir).name).toBeNull();
    expect(storeLines()).toHaveLength(0);
  });

  // What the file said is what a worktree inherits and what the settings preview reports; the
  // filled-in colour must not leak into it.
  it("keeps loadDirConfig reporting only what the files said", () => {
    const main = repo("alpha");
    publicDirConfig(main);
    expect(loadDirConfig(main).headerColor).toBeNull();
    expect(loadDirConfig(main).name).toBeNull();
  });
});
