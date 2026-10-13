// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { GRID_STATE_CHANNEL } from "../../../common/gridStateSync";
import { createGridStateStore, mountGridStateRoutes } from "../../../server/routes/grid-state-routes";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mt-grid-state-"));
  roots.push(root);
  const file = path.join(root, "grid-state.json");
  const publish = vi.fn();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountGridStateRoutes(app, { store: createGridStateStore(file), publish });
  return { app, file, publish };
};

const state = (session: string) => ({ cells: [{ uid: 0, session, cwd: "/work" }], expanded: null, page: 0, nextUid: 1, sortMode: "manual" });

describe("shared grid state routes", () => {
  it("starts empty, persists the first revision, and publishes the accepted snapshot", async () => {
    const { app, file, publish } = setup();
    expect((await request(app).get("/api/grid-state")).body).toEqual({ revision: 0, state: null, updatedBy: null });

    const payload = state("11111111-1111-1111-1111-111111111111");
    const res = await request(app).put("/api/grid-state").send({ baseRevision: 0, state: payload, clientId: "local-tab" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revision: 1, state: payload, updatedBy: "local-tab" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(res.body);
    expect(publish).toHaveBeenCalledWith(GRID_STATE_CHANNEL, res.body);
  });

  it("rejects a stale writer with the authoritative snapshot and does not publish it", async () => {
    const { app, publish } = setup();
    const first = state("11111111-1111-1111-1111-111111111111");
    const second = state("22222222-2222-2222-2222-222222222222");
    await request(app).put("/api/grid-state").send({ baseRevision: 0, state: first, clientId: "first" });
    publish.mockClear();

    const stale = await request(app).put("/api/grid-state").send({ baseRevision: 0, state: second, clientId: "stale" });

    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ revision: 1, state: first, updatedBy: "first" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("serializes simultaneous writes so exactly one wins a revision", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mt-grid-state-"));
    roots.push(root);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const write = vi.fn(async () => await blocked);
    const store = createGridStateStore(path.join(root, "state.json"), write);

    const a = store.update(0, state("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), "a");
    const b = store.update(0, state("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), "b");
    release?.();
    const results = await Promise.all([a, b]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or oversized writes", async () => {
    const { app } = setup();
    expect((await request(app).put("/api/grid-state").send({ baseRevision: -1, state: {}, clientId: "x" })).status).toBe(400);
    expect((await request(app).put("/api/grid-state").send({ baseRevision: 0, state: [], clientId: "x" })).status).toBe(400);
    expect(
      (
        await request(app)
          .put("/api/grid-state")
          .send({ baseRevision: 0, state: { value: "x".repeat(300_000) }, clientId: "x" })
      ).status,
    ).toBe(400);
  });
});
