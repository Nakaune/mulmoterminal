import { describe, it, expect } from "vitest";
import { isViewedRemotely, servingTargetFor } from "../../../src/composables/remoteFileOpen";

describe("isViewedRemotely", () => {
  // The desktop is served from `localhost`; that is the one place a file-manager window opens
  // in front of whoever clicked.
  it("is false on the desktop", () => {
    expect(isViewedRemotely("localhost")).toBe(false);
  });

  // The two ways this app is reached from elsewhere: an SSH tunnel (the IP literal) and the
  // machine's Tailscale name.
  it("is true through a tunnel and through a real hostname", () => {
    expect(isViewedRemotely("127.0.0.1")).toBe(true);
    expect(isViewedRemotely("desktop-bg340l6.taile7ea42.ts.net")).toBe(true);
  });
});

describe("servingTargetFor", () => {
  const cwd = "/home/me/proj";
  const home = "/home/me";

  it("keeps a path under the session cwd relative to it", () => {
    expect(servingTargetFor("src/main.ts", cwd, home, [])).toEqual({ base: cwd, rel: "src/main.ts" });
    expect(servingTargetFor("/home/me/proj/docs/a.md", cwd, home, [])).toEqual({ base: cwd, rel: "docs/a.md" });
  });

  // The case the in-app routes used to die on: the base moves to the file's own folder, so the
  // path never has to escape anything.
  it("serves an absolute path outside the cwd from its own folder", () => {
    expect(servingTargetFor("/home/me/other/docs/a.md", cwd, home, [])).toEqual({ base: "/home/me/other/docs", rel: "a.md" });
  });

  it("resolves a relative path that climbs out of the cwd", () => {
    expect(servingTargetFor("../other/docs/a.md", cwd, home, [])).toEqual({ base: "/home/me/other/docs", rel: "a.md" });
  });

  it("expands a home-relative path", () => {
    expect(servingTargetFor("~/.claude/rules/a.md", cwd, home, [])).toEqual({ base: "/home/me/.claude/rules", rel: "a.md" });
  });

  // The raw route (images, PDFs) only serves from a live session's directory, so one that
  // contains the path beats the file's own folder — and the most specific one beats its parent.
  it("prefers another live session's cwd that contains the path", () => {
    const sessions = ["/home/me", "/home/me/other", cwd];
    expect(servingTargetFor("/home/me/other/shots/a.png", cwd, home, sessions)).toEqual({ base: "/home/me/other", rel: "shots/a.png" });
  });

  it("prefers the clicking session's own cwd over a deeper session inside it", () => {
    expect(servingTargetFor("sub/x/a.png", cwd, home, ["/home/me/proj/sub"])).toEqual({ base: cwd, rel: "sub/x/a.png" });
  });

  // Segment-wise, not startsWith: `/home/me/proj2` is not under `/home/me/proj`.
  it("does not mistake a sibling with a shared prefix for the cwd", () => {
    expect(servingTargetFor("/home/me/proj2/a.md", cwd, home, [])).toEqual({ base: "/home/me/proj2", rel: "a.md" });
  });

  it("serves a file at the filesystem root from the root", () => {
    expect(servingTargetFor("/a.md", cwd, home, [])).toEqual({ base: "/", rel: "a.md" });
  });

  // Nothing to resolve against: hand it over as upstream does and let the server refuse it.
  it("falls back to the cwd-relative form when home is not known yet", () => {
    expect(servingTargetFor("~/.claude/a.md", cwd, null, [])).toEqual({ base: cwd, rel: "~/.claude/a.md" });
  });

  it("falls back to the cwd-relative form for a cwd that is not a POSIX path", () => {
    expect(servingTargetFor("src/main.ts", "C:\\Users\\me\\proj", null, [])).toEqual({ base: "C:\\Users\\me\\proj", rel: "src/main.ts" });
  });
});
