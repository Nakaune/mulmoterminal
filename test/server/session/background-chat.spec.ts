// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { backgroundChatMessage, parseBackgroundChat, resolveSpawnCwd, spawnModeFor } from "../../../server/session/background-chat.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const ok = (body: unknown) => {
  const parsed = parseBackgroundChat(body);
  if (!parsed.ok) throw new Error(`expected a request, got: ${parsed.message}`);
  return parsed.request;
};

// The body comes from an agent tool call, so it is whatever a model produced. Every field
// has to read as absent unless it is exactly what we accept.
describe("parseBackgroundChat", () => {
  it("accepts a plain message and defaults the rest", () => {
    expect(ok({ message: "look at the failing test" })).toEqual({
      agent: "claude",
      draft: false,
      hidden: false,
      message: "look at the failing test",
    });
  });

  it("trims the message", () => {
    expect(ok({ message: "  spaced  " }).message).toBe("spaced");
  });

  // Every agent the UI offers has to survive the parse, or the toggle silently spawns claude.
  it("keeps an agent it hosts, and falls back to claude for one it does not", () => {
    expect(ok({ message: "go", agent: "codex" }).agent).toBe("codex");
    expect(ok({ message: "go", agent: "antigravity" }).agent).toBe("antigravity");
    expect(ok({ message: "go", agent: "gpt-9" }).agent).toBe("claude");
  });

  describe("rejection", () => {
    const rejected = (body: unknown) => {
      const parsed = parseBackgroundChat(body);
      expect(parsed.ok).toBe(false);
      return parsed.ok ? "" : parsed.message;
    };

    it("refuses a missing, empty or whitespace-only message", () => {
      // Spawning on an empty message would leave the user an idle session with no task.
      expect(rejected({})).toMatch(/`message` is required/);
      expect(rejected({ message: "" })).toMatch(/`message` is required/);
      expect(rejected({ message: "   " })).toMatch(/`message` is required/);
    });

    it("refuses a message that is not a string", () => {
      for (const message of [42, ["hi"], null, { text: "hi" }]) {
        expect(rejected({ message })).toMatch(/`message` is required/);
      }
    });

    it("refuses a body that is not an object", () => {
      for (const body of [null, undefined, "just a string", 42, []]) {
        expect(rejected(body)).toMatch(/`message` is required/);
      }
    });
  });

  describe("flags", () => {
    it("takes draft only when it is exactly true", () => {
      // A model may pass "true" or 1; anything but the boolean must run the prompt
      // rather than silently leaving it unsent in the input box.
      expect(ok({ message: "m", draft: true }).draft).toBe(true);
      expect(ok({ message: "m", draft: "true" }).draft).toBe(false);
      expect(ok({ message: "m", draft: 1 }).draft).toBe(false);
      expect(ok({ message: "m" }).draft).toBe(false);
    });

    it("takes hidden only when it is exactly true", () => {
      expect(ok({ message: "m", hidden: true }).hidden).toBe(true);
      expect(ok({ message: "m", hidden: "yes" }).hidden).toBe(false);
    });

    it("takes codex only for that exact string, and defaults to claude", () => {
      expect(ok({ message: "m", agent: "codex" }).agent).toBe("codex");
      expect(ok({ message: "m", agent: "Codex" }).agent).toBe("claude");
      expect(ok({ message: "m", agent: "gpt" }).agent).toBe("claude");
      expect(ok({ message: "m" }).agent).toBe("claude");
    });
  });
});

describe("spawnModeFor", () => {
  it("runs a claude prompt by default", () => {
    expect(spawnModeFor("claude", false)).toBe("claude-run");
  });

  it("drafts a claude prompt when asked", () => {
    expect(spawnModeFor("claude", true)).toBe("claude-draft");
  });

  it("runs a codex prompt whether or not a draft was asked for", () => {
    // codex has no editable-draft path — no stable TUI ready-marker to type against —
    // so a codex draft has to become a run rather than nothing at all.
    expect(spawnModeFor("codex", false)).toBe("codex-run");
    expect(spawnModeFor("codex", true)).toBe("codex-run");
  });
});

describe("backgroundChatMessage", () => {
  it("says the codex session is already running", () => {
    const text = backgroundChatMessage("codex", false, SESSION);
    expect(text).toContain(SESSION);
    expect(text).toMatch(/auto-running/);
  });

  it("says a draft is waiting for the user rather than running", () => {
    // The caller decides what to tell the user next, so a draft must not read as started.
    const text = backgroundChatMessage("claude", true, SESSION);
    expect(text).toMatch(/prefilled/);
    expect(text).not.toMatch(/runs in parallel/);
  });

  it("says a claude run is working in parallel", () => {
    const text = backgroundChatMessage("claude", false, SESSION);
    expect(text).toMatch(/runs in parallel/);
    expect(text).not.toMatch(/prefilled/);
  });

  it("always carries the session id, which is how the caller reopens it", () => {
    for (const [agent, draft] of [
      ["claude", false],
      ["claude", true],
      ["codex", false],
    ] as const) {
      expect(backgroundChatMessage(agent, draft, SESSION)).toContain(SESSION);
    }
  });
});

describe("parseBackgroundChat cwd", () => {
  it("keeps an absolute path and leaves it absent otherwise", () => {
    expect(ok({ message: "go", cwd: "/home/u/repo" }).cwd).toBe("/home/u/repo");
    expect(ok({ message: "go" }).cwd).toBeUndefined();
  });

  it("rejects a relative path, a non-string and an empty string", () => {
    for (const cwd of ["repo", "./repo", "../repo", "", 42, null, ["/abs"], { path: "/abs" }]) {
      const parsed = parseBackgroundChat({ message: "go", cwd });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(/absolute directory path/);
    }
  });
});

describe("resolveSpawnCwd", () => {
  let tmp: string;
  let base: string;
  let clone: string;
  let outside: string;
  const fail = async (cwd: string, roots: string[]) => {
    const r = await resolveSpawnCwd(cwd, roots);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.message;
  };

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bgchat-cwd-")));
    base = path.join(tmp, "base");
    clone = path.join(tmp, "clone");
    outside = path.join(tmp, "outside");
    [base, path.join(base, "sub"), clone, path.join(clone, "pkg"), outside].forEach((d) => mkdirSync(d, { recursive: true }));
    symlinkSync(outside, path.join(base, "escape"));
    writeFileSync(path.join(base, "file.txt"), "x");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("passes the default cwd itself and a directory under it", async () => {
    expect(await resolveSpawnCwd(base, [base])).toEqual({ ok: true, cwd: base });
    expect(await resolveSpawnCwd(path.join(base, "sub"), [base])).toEqual({ ok: true, cwd: path.join(base, "sub") });
  });

  it("passes a known clone and a directory under it", async () => {
    expect(await resolveSpawnCwd(clone, [base, clone])).toEqual({ ok: true, cwd: clone });
    expect(await resolveSpawnCwd(path.join(clone, "pkg"), [base, clone])).toEqual({ ok: true, cwd: path.join(clone, "pkg") });
  });

  it("refuses a directory that is neither under the default nor a known clone", async () => {
    expect(await fail(outside, [base, clone])).toMatch(/neither inside/);
  });

  it("does not treat a sibling that merely shares a name prefix as inside", async () => {
    const sibling = `${base}-other`;
    mkdirSync(sibling);
    expect(await fail(sibling, [base])).toMatch(/neither inside/);
  });

  it("refuses a path that does not exist, and one that is a file", async () => {
    expect(await fail(path.join(base, "missing"), [base])).toMatch(/not an existing directory/);
    expect(await fail(path.join(tmp, "nope", "deeper"), [tmp])).toMatch(/not an existing directory/);
    expect(await fail(path.join(base, "file.txt"), [base])).toMatch(/not an existing directory/);
  });

  it("refuses a symlink under an allowed tree that leads outside it", async () => {
    expect(await fail(path.join(base, "escape"), [base])).toMatch(/neither inside/);
  });

  it("refuses a '..' path that climbs out of an allowed tree", async () => {
    expect(await fail(path.join(base, "sub", "..", "..", "outside"), [base])).toMatch(/neither inside/);
  });

  it("ignores an allowed root that no longer exists", async () => {
    expect(await fail(outside, [path.join(tmp, "gone")])).toMatch(/neither inside/);
  });
});
