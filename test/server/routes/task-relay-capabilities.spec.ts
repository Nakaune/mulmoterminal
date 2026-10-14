// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseBackgroundChat, resolveSpawnCwd } from "../../../server/session/background-chat.js";
import { fingerprintTaskRelayBuild, mountTaskRelayCapabilities } from "../../../server/routes/task-relay-capabilities.js";
import { mountPluginRoutes, type PluginRouteDeps } from "../../../server/routes/plugin-routes.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../server/config/env.js", () => ({
  get CLAUDE_CWD() {
    return fixture.root;
  },
  PORT: 0,
}));
vi.mock("../../../server/session/registry.js", () => ({ backgroundMarkers: new Set(), markFailedWorker: vi.fn(), markUnplacedSession: vi.fn() }));
vi.mock("../../../server/session/hiddenMarker.js", () => ({
  runWithHiddenMarker: (_hidden: boolean, _id: string, _markers: unknown, run: () => void) => run(),
}));
vi.mock("../../../server/session/completion-hooks.js", () => ({ registerCompletionHook: vi.fn() }));
vi.mock("../../../server/infra/gui-mcp-registration.js", () => ({ registeredGuiMcpGroups: async () => [] }));
vi.mock("../../../server/agents/codex-skills.js", () => ({ codexifySkillSeed: (message: string) => message }));
vi.mock("../../../server/infra/collection-tool.js", () => ({ manageCollectionHandler: vi.fn() }));
vi.mock("../../../server/config/config-routes.js", () => ({ getCwdPresets: () => [], getRepoDirs: () => [] }));
vi.mock("../../../server/git/repo-dirs.js", () => ({ repoDirsFromPresets: async () => [] }));

let root: string;
let outside: string;
const savedRepo = process.env.MULMO_TASK_RELAY_REPO;
const savedWorktree = process.env.MULMO_TASK_RELAY_WORKTREE;
beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "mulmo-relay-allowed-"));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), "mulmo-relay-outside-"));
  process.env.MULMO_TASK_RELAY_REPO = "Nakaune/AidaNote";
  process.env.MULMO_TASK_RELAY_WORKTREE = root;
  fixture.root = root;
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
  if (savedRepo === undefined) delete process.env.MULMO_TASK_RELAY_REPO;
  else process.env.MULMO_TASK_RELAY_REPO = savedRepo;
  if (savedWorktree === undefined) delete process.env.MULMO_TASK_RELAY_WORKTREE;
  else process.env.MULMO_TASK_RELAY_WORKTREE = savedWorktree;
});

const app = () => {
  const server = express();
  mountTaskRelayCapabilities(server, (cwd) => resolveSpawnCwd(cwd, [root]));
  return server;
};

describe("task relay HTTP capability contract", () => {
  it("advertises the exact canonical worktree and source fingerprint", async () => {
    const response = await request(app()).get("/api/task-relay/capabilities");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      schema: 1,
      spawn_endpoint: "/api/plugin/spawnBackgroundChat",
      cwd_enforced: true,
      repo: "Nakaune/AidaNote",
      worktree: root,
      build_id: response.body.build_id,
    });
    expect(response.body.build_id).toMatch(/^[0-9a-f]{64}$/);
  });
  it("imports and mounts unconfigured with a minimal filesystem mock", async () => {
    delete process.env.MULMO_TASK_RELAY_WORKTREE;
    vi.resetModules();
    vi.doMock("node:fs", () => ({}));
    try {
      const isolated = await import("../../../server/routes/task-relay-capabilities.js");
      const server = express();
      isolated.mountTaskRelayCapabilities(server, async (cwd) => ({ ok: true, cwd }));
      expect((await request(server).get("/api/task-relay/capabilities")).status).toBe(503);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
  it("does not fingerprint an unconfigured mount or activate it from later environment changes", async () => {
    delete process.env.MULMO_TASK_RELAY_WORKTREE;
    const capture = vi.fn(() => {
      throw new Error("minimal fs mock must not be used");
    });
    const server = express();
    mountTaskRelayCapabilities(server, (cwd) => resolveSpawnCwd(cwd, [root]), capture);
    expect(capture).not.toHaveBeenCalled();
    process.env.MULMO_TASK_RELAY_WORKTREE = root;
    expect((await request(server).get("/api/task-relay/capabilities")).status).toBe(503);
    expect(capture).not.toHaveBeenCalled();
  });
  it("captures the configured build once at mount and retains startup configuration", async () => {
    const capturedId = "a".repeat(64);
    const capture = vi.fn(() => capturedId);
    const server = express();
    mountTaskRelayCapabilities(server, (cwd) => resolveSpawnCwd(cwd, [root]), capture);
    expect(capture).toHaveBeenCalledOnce();
    process.env.MULMO_TASK_RELAY_WORKTREE = outside;
    for (let i = 0; i < 2; i++) {
      const response = await request(server).get("/api/task-relay/capabilities");
      expect(response.status).toBe(200);
      expect(response.body.worktree).toBe(root);
      expect(response.body.build_id).toBe(capturedId);
    }
    expect(capture).toHaveBeenCalledOnce();
  });
  it("fails closed when startup fingerprint capture throws without retrying", async () => {
    const capture = vi.fn(() => {
      throw new Error("unreadable shipped source");
    });
    const server = express();
    mountTaskRelayCapabilities(server, (cwd) => resolveSpawnCwd(cwd, [root]), capture);
    for (let i = 0; i < 2; i++) expect((await request(server).get("/api/task-relay/capabilities")).status).toBe(503);
    expect(capture).toHaveBeenCalledOnce();
  });
  it("does not accept query parameters in place of owner configuration", async () => {
    delete process.env.MULMO_TASK_RELAY_WORKTREE;
    const response = await request(app()).get("/api/task-relay/capabilities").query({ worktree: root, repo: "Nakaune/AidaNote" });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "task_relay_unconfigured" });
  });
  it("refuses an out-of-root worktree", async () => {
    process.env.MULMO_TASK_RELAY_WORKTREE = outside;
    expect((await request(app()).get("/api/task-relay/capabilities")).status).toBe(503);
  });
  it("rechecks worktree existence for each request", async () => {
    const server = app();
    expect((await request(server).get("/api/task-relay/capabilities")).status).toBe(200);
    await fsp.rm(root, { recursive: true });
    expect((await request(server).get("/api/task-relay/capabilities")).status).toBe(503);
  });
  it("refuses a symlink alias as capability worktree", async () => {
    const directory = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await fsp.mkdir(directory);
    await fsp.symlink(directory, alias);
    process.env.MULMO_TASK_RELAY_WORKTREE = alias;
    expect((await request(app()).get("/api/task-relay/capabilities")).status).toBe(503);
  });
});

describe("spawn cwd boundary", () => {
  it.each(["relative", "", null, 7, {}, "/invalid\0path"])("refuses invalid explicit cwd %j instead of using a default", (cwd) => {
    expect(parseBackgroundChat({ message: "non-destructive fixture", cwd }).ok).toBe(false);
  });
  it("keeps the legacy default only when cwd is absent", () => {
    expect(parseBackgroundChat({ message: "non-destructive fixture" }).ok).toBe(true);
  });
  it("resolves an allowed symlink to its canonical target", async () => {
    const directory = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await fsp.mkdir(directory);
    await fsp.symlink(directory, alias);
    expect(await resolveSpawnCwd(alias, [root])).toEqual({ ok: true, cwd: directory });
  });
  it("refuses a symlink that escapes the allowed root", async () => {
    const alias = path.join(root, "escape");
    await fsp.symlink(outside, alias);
    expect((await resolveSpawnCwd(alias, [root])).ok).toBe(false);
  });
});

describe("runtime source fingerprint", () => {
  it("changes when the lower-level spawner or startup code changes", async () => {
    await fsp.writeFile(path.join(root, "package.json"), "{}");
    for (const directory of ["server", "common", "plugins", "bin"]) await fsp.mkdir(path.join(root, directory));
    const spawner = path.join(root, "server", "spawn.ts");
    const startup = path.join(root, "bin", "start.js");
    await fsp.writeFile(spawner, "canonical-cwd");
    await fsp.writeFile(startup, "tsx");
    const before = fingerprintTaskRelayBuild(root);
    await fsp.writeFile(spawner, "wrong-cwd");
    const changedSpawner = fingerprintTaskRelayBuild(root);
    expect(changedSpawner).not.toBe(before);
    await fsp.writeFile(startup, "another-runtime");
    expect(fingerprintTaskRelayBuild(root)).not.toBe(changedSpawner);
  });
});

describe("production plugin route with a non-executing spawner", () => {
  const pluginApp = () => {
    const server = express();
    server.use(express.json());
    const spawnClaudePty = vi.fn();
    mountPluginRoutes(server, {
      spawnClaudePty,
      spawnCodexPty: vi.fn(),
      spawnAntigravityPty: vi.fn(),
      spawnGrokPty: vi.fn(),
      registerBackgroundSession: vi.fn(),
    } as unknown as PluginRouteDeps);
    return { server, spawnClaudePty };
  };
  it("forwards and acknowledges the exact canonical cwd", async () => {
    const directory = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await fsp.mkdir(directory);
    await fsp.symlink(directory, alias);
    const { server, spawnClaudePty } = pluginApp();
    const response = await request(server).post("/api/plugin/spawnBackgroundChat").send({ message: "fixture only", cwd: alias });
    expect(response.status).toBe(200);
    expect(spawnClaudePty).toHaveBeenCalledOnce();
    expect(spawnClaudePty.mock.calls[0]?.[3]).toEqual({ initialPrompt: "fixture only", cwd: directory });
    expect(response.body.jsonData.cwd).toBe(directory);
  });
  it("does not spawn when an explicit cwd is invalid", async () => {
    const { server, spawnClaudePty } = pluginApp();
    const response = await request(server).post("/api/plugin/spawnBackgroundChat").send({ message: "fixture only", cwd: "relative" });
    expect(response.body.message).toMatch(/absolute/);
    expect(spawnClaudePty).not.toHaveBeenCalled();
  });
  it("does not spawn through an escaping symlink", async () => {
    const alias = path.join(root, "escape");
    await fsp.symlink(outside, alias);
    const { server, spawnClaudePty } = pluginApp();
    const response = await request(server).post("/api/plugin/spawnBackgroundChat").send({ message: "fixture only", cwd: alias });
    expect(response.body.message).toMatch(/no session was started/);
    expect(spawnClaudePty).not.toHaveBeenCalled();
  });
  it("mounts the capability proof through the actual plugin setup", async () => {
    const { server, spawnClaudePty } = pluginApp();
    const response = await request(server).get("/api/task-relay/capabilities");
    expect(response.status).toBe(200);
    expect(response.body.worktree).toBe(root);
    expect(spawnClaudePty).not.toHaveBeenCalled();
  });
});
