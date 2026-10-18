// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { ACTIVE_CLIENT_CHANNEL } from "../../../common/activeClient";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createActiveClientStore, mayWrite, mountActiveClientRoutes } from "../../../server/routes/active-client-routes";

const setup = () => {
  const publish = vi.fn();
  const app = express();
  app.use(express.json());
  mountActiveClientRoutes(app, { store: createActiveClientStore(), publish });
  return { app, publish };
};

describe("active client routes", () => {
  it("starts with nobody active", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/active-client")).body).toEqual({ clientId: null });
  });

  it("sets the active client and publishes it", async () => {
    const { app, publish } = setup();
    const res = await request(app).post("/api/active-client").send({ clientId: "tab-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clientId: "tab-1" });
    expect(publish).toHaveBeenCalledWith(ACTIVE_CLIENT_CHANNEL, { clientId: "tab-1" });
    expect((await request(app).get("/api/active-client")).body).toEqual({ clientId: "tab-1" });
  });

  // A restart must not empty it: every reconnecting tab would see "nobody" and claim, and the last
  // one to land — possibly a forgotten tab on another machine — would win.
  it("keeps the active client across a restart when given a file", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "mt-active-")), "active-client.json");
    const write = vi.fn(async (f: string, data: string | Uint8Array) => writeFileSync(f, data));
    createActiveClientStore(file, write).set("tab-1");
    await Promise.resolve();
    expect(createActiveClientStore(file, write).read()).toEqual({ clientId: "tab-1" });
  });

  it("lets anyone write before a claim, and only the active tab after", () => {
    const store = createActiveClientStore();
    expect(mayWrite(store, "old-tab")).toBe(true);
    store.set("tab-1");
    expect(mayWrite(store, "tab-1")).toBe(true);
    expect(mayWrite(store, "old-tab")).toBe(false);
  });

  it("rejects a bad clientId without publishing", async () => {
    const { app, publish } = setup();
    for (const body of [{}, { clientId: 5 }, { clientId: "" }, { clientId: "a b" }, { clientId: "x".repeat(129) }]) {
      expect((await request(app).post("/api/active-client").send(body)).status).toBe(400);
    }
    expect(publish).not.toHaveBeenCalled();
  });
});
