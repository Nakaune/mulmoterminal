// @vitest-environment node
// The cwd a spawnBackgroundChat request names reaches the spawner, and one the server will not
// accept starts nothing. resolveSpawnCwd has its own spec; this one proves the route USES it.
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import os from "node:os";
import path from "node:path";

const dirs = vi.hoisted(() => ({ base: "", clone: "" }));

vi.mock("node:fs", () => {
  const promises = {
    readFile: vi.fn(async () => ""),
    appendFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
  return { promises, default: { promises } };
});
vi.mock("../../../server/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/config/env.js")>();
  return {
    ...actual,
    get CLAUDE_CWD() {
      return dirs.base;
    },
  };
});
vi.mock("../../../server/config/config-routes.js", () => ({ getCwdPresets: () => [], getRepoDirs: () => ({}) }));
vi.mock("../../../server/git/repo-dirs.js", () => ({
  repoDirsFromPresets: async () => [{ repo: "o/r", primary: null, dirs: [{ path: dirs.clone, label: "clone", orderPriority: null }] }],
}));

const nodeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
dirs.base = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "bgchat-route-")));
dirs.clone = path.join(dirs.base, "..", `${path.basename(dirs.base)}-clone`);
nodeFs.mkdirSync(dirs.clone);

const { mountPluginRoutes } = await import("../../../server/routes/plugin-routes.js");

const spawnClaudePty = vi.fn(() => ({}));
const spawnCodexPty = vi.fn(() => ({}));
const app = express();
app.use(express.json());
mountPluginRoutes(app, {
  spawnClaudePty: spawnClaudePty as never,
  spawnCodexPty: spawnCodexPty as never,
  spawnAntigravityPty: (() => ({})) as never,
  spawnGrokPty: (() => ({})) as never,
  registerBackgroundSession: () => {},
});

afterAll(() => {
  nodeFs.rmSync(dirs.clone, { recursive: true, force: true });
  nodeFs.rmSync(dirs.base, { recursive: true, force: true });
});

const post = (body: object) =>
  request(app)
    .post("/api/plugin/spawnBackgroundChat")
    .send({ message: "go", ...body });

describe("spawnBackgroundChat cwd", () => {
  beforeEach(() => {
    spawnClaudePty.mockClear();
    spawnCodexPty.mockClear();
  });

  it("starts a claude session in a known clone", async () => {
    const res = await post({ cwd: dirs.clone });
    expect((res.body as { jsonData?: unknown }).jsonData).toBeDefined();
    expect(spawnClaudePty).toHaveBeenCalledWith(expect.any(String), null, null, expect.objectContaining({ cwd: dirs.clone, initialPrompt: "go" }));
  });

  it("starts a codex session in the requested directory", async () => {
    const sub = path.join(dirs.base, "sub");
    nodeFs.mkdirSync(sub);
    await post({ cwd: sub, agent: "codex" });
    expect(spawnCodexPty).toHaveBeenCalledWith(expect.any(String), null, null, sub, true, expect.anything());
  });

  it("uses the default directory when no cwd is given", async () => {
    await post({});
    expect(spawnClaudePty).toHaveBeenCalledWith(expect.any(String), null, null, expect.objectContaining({ cwd: dirs.base }));
  });

  it("refuses a directory outside both, as a 200 narration, and spawns nothing", async () => {
    const res = await post({ cwd: os.tmpdir() });
    expect(res.status).toBe(200);
    expect((res.body as { message: string }).message).toMatch(/neither inside/);
    expect(spawnClaudePty).not.toHaveBeenCalled();
  });
});
