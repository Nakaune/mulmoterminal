import { describe, it, expect } from "vitest";
import { homeRelative, truncateFront, formatCwd, worktreeTail, worktreeLabel } from "../../../src/components/cwdDisplay.js";

describe("homeRelative", () => {
  it("anchors a path under home on ~", () => {
    expect(homeRelative("/Users/me/ss/proj", "/Users/me")).toBe("~/ss/proj");
    expect(homeRelative("/Users/me", "/Users/me")).toBe("~");
  });
  it("leaves non-home and home-prefix-lookalike paths untouched", () => {
    expect(homeRelative("/var/data", "/Users/me")).toBe("/var/data");
    expect(homeRelative("/Users/mehmet/x", "/Users/me")).toBe("/Users/mehmet/x"); // not a real segment boundary
    expect(homeRelative("/var/data", null)).toBe("/var/data");
  });

  it("anchors Windows paths (backslashes, case-insensitive drive/segments)", () => {
    expect(homeRelative("C:\\Users\\me\\proj", "C:\\Users\\me")).toBe("~\\proj");
    expect(homeRelative("c:\\users\\ME\\proj", "C:\\Users\\me")).toBe("~\\proj"); // case-insensitive
    expect(homeRelative("C:\\Users\\me", "C:\\Users\\me")).toBe("~");
    expect(homeRelative("D:\\other\\x", "C:\\Users\\me")).toBe("D:\\other\\x");
  });
});

describe("truncateFront", () => {
  it("returns the string unchanged when it fits", () => {
    expect(truncateFront("~/ss/proj", 30)).toBe("~/ss/proj");
  });
  it("keeps the tail and prefixes an ellipsis when too long", () => {
    const out = truncateFront("~/a/b/c/d/e/f/g/h/i/j/k", 10);
    expect(out.startsWith("…")).toBe(true);
    expect(out).toHaveLength(10);
    expect("~/a/b/c/d/e/f/g/h/i/j/k".endsWith(out.slice(1))).toBe(true); // it's a suffix
  });
});

describe("formatCwd", () => {
  it("combines home-anchoring and front truncation", () => {
    expect(formatCwd("/Users/me/ss/proj", "/Users/me")).toBe("~/ss/proj");
    const long = "/Users/me/work/clients/acme/backend/services/auth/handlers";
    const out = formatCwd(long, "/Users/me", 20);
    expect(out.startsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(long.endsWith(out.slice(1))).toBe(true);
  });
  it("returns empty for a null cwd", () => {
    expect(formatCwd(null, "/Users/me")).toBe("");
  });
});

describe("worktreeLabel", () => {
  it("extracts <repo> and <task> from a managed worktree path", () => {
    expect(worktreeLabel("/Users/me/.mulmoterminal/worktrees/myrepo-1a2b3c4d/fix-login")).toEqual({ repo: "myrepo", task: "fix-login" });
  });
  it("keeps a repo name that itself contains dashes", () => {
    expect(worktreeLabel("/x/worktrees/my-cool-repo-deadbeef/task-2")).toEqual({ repo: "my-cool-repo", task: "task-2" });
  });
  it("handles Windows separators", () => {
    expect(worktreeLabel("C:\\Users\\me\\.mulmoterminal\\worktrees\\app-0badf00d\\wip")).toEqual({ repo: "app", task: "wip" });
  });
  it("returns null for non-worktree paths", () => {
    expect(worktreeLabel(null)).toBeNull();
    expect(worktreeLabel("/Users/me/ss/proj")).toBeNull();
    expect(worktreeLabel("/x/worktrees/no-hash-here/task")).toBeNull(); // dir lacks the -<8hex> suffix
    expect(worktreeLabel("/x/worktrees/app-1a2b3c4d")).toBeNull(); // no task segment
  });
});

describe("worktreeTail", () => {
  it("keeps only the branch part of a wt/ worktree", () => {
    expect(worktreeTail("~/project/wt/feat/act-formulation")).toBe("feat/act-formulation");
    expect(worktreeTail("/home/me/project/wt/fix/a-bug")).toBe("fix/a-bug");
  });

  it("keeps a branch with no type prefix, and one with extra depth", () => {
    expect(worktreeTail("~/project/wt/hotfix")).toBe("hotfix");
    expect(worktreeTail("~/project/wt/feat/a/b")).toBe("feat/a/b");
  });

  // Nothing follows it, so there is no branch to show and shortening would leave the cell with no
  // location at all.
  it("leaves a path that ends at the wt root alone", () => {
    expect(worktreeTail("~/project/wt")).toBe("~/project/wt");
  });

  it("leaves paths with no wt segment alone", () => {
    expect(worktreeTail("~/project/main")).toBe("~/project/main");
    expect(worktreeTail("~/witness/x")).toBe("~/witness/x"); // not a segment called exactly "wt"
  });

  // MulmoTerminal's own managed layout is worktreeLabel's to render; this must not touch it.
  it("leaves the managed worktrees layout alone", () => {
    expect(worktreeTail("~/.mulmoterminal/worktrees/proj-1a2b3c4d/task")).toBe("~/.mulmoterminal/worktrees/proj-1a2b3c4d/task");
  });

  it("handles Windows separators", () => {
    expect(worktreeTail("~\\project\\wt\\feat\\x")).toBe("feat\\x");
  });
});

describe("formatCwd with a worktree", () => {
  // The whole point: what the header shows for the directory in the screenshot that started this.
  it("shows the branch instead of the road to it", () => {
    expect(formatCwd("/home/example/project/wt/feat/act-formulation", "/home/example")).toBe("feat/act-formulation");
  });

  it("still truncates from the front when even the branch is too long", () => {
    const shown = formatCwd("/home/example/project/wt/feat/a-very-long-branch-name-indeed", "/home/example", 20);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown).toHaveLength(20);
  });
});
