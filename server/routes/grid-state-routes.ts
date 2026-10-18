import fs from "node:fs/promises";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { GRID_STATE_API, GRID_STATE_CHANNEL, isGridStateSnapshot, type GridStateSnapshot } from "../../common/gridStateSync.js";
import { isRecord } from "../../common/isRecord.js";
import { writeFileAtomic } from "../files/atomic-write.js";

const EMPTY_SNAPSHOT: GridStateSnapshot = { revision: 0, state: null, updatedBy: null };
const MAX_STATE_BYTES = 256 * 1024;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface GridStateStore {
  read(): Promise<GridStateSnapshot>;
  update(baseRevision: number, state: unknown, clientId: string): Promise<{ accepted: boolean; snapshot: GridStateSnapshot }>;
}

export function createGridStateStore(file: string, write = writeFileAtomic): GridStateStore {
  let snapshot: GridStateSnapshot = EMPTY_SNAPSHOT;
  const hydrated = fs
    .readFile(file, "utf8")
    .then((raw) => {
      const parsed: unknown = JSON.parse(raw);
      if (isGridStateSnapshot(parsed)) snapshot = parsed;
    })
    .catch(() => {});
  let updates: Promise<unknown> = Promise.resolve();

  return {
    async read() {
      await hydrated;
      return snapshot;
    },
    async update(baseRevision, state, clientId) {
      await hydrated;
      const run = updates.then(async () => {
        if (baseRevision !== snapshot.revision) return { accepted: false, snapshot };
        const next: GridStateSnapshot = { revision: snapshot.revision + 1, state, updatedBy: clientId };
        await write(file, `${JSON.stringify(next)}\n`);
        snapshot = next;
        return { accepted: true, snapshot };
      });
      updates = run.catch(() => {});
      return await run;
    },
  };
}

function validUpdate(body: unknown): body is { baseRevision: number; state: Record<string, unknown>; clientId: string } {
  if (!isRecord(body) || !Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0) return false;
  if (!isRecord(body.state) || typeof body.clientId !== "string" || !CLIENT_ID_RE.test(body.clientId)) return false;
  return Buffer.byteLength(JSON.stringify(body.state), "utf8") <= MAX_STATE_BYTES;
}

export function mountGridStateRoutes(
  app: Express,
  deps: { store: GridStateStore; publish: (channel: string, data: unknown) => void; mayWrite?: (clientId: string) => boolean },
): void {
  app.get(GRID_STATE_API, async (_req: Request, res: Response) => {
    res.json(await deps.store.read());
  });

  app.put(GRID_STATE_API, async (req: Request, res: Response) => {
    if (!validUpdate(req.body)) return res.status(400).json({ error: "invalid grid state" });
    // 403, not 409: a 409 body is a snapshot the client adopts and then writes again, which would
    // loop. An older client reads a non-snapshot error body as "nothing to do" and stops.
    if (deps.mayWrite && !deps.mayWrite(req.body.clientId)) return res.status(403).json({ error: "another tab is active" });
    try {
      const result = await deps.store.update(req.body.baseRevision, req.body.state, req.body.clientId);
      if (!result.accepted) return res.status(409).json(result.snapshot);
      deps.publish(GRID_STATE_CHANNEL, result.snapshot);
      return res.json(result.snapshot);
    } catch (err) {
      console.error("[grid-state] failed to persist:", err);
      return res.status(500).json({ error: "failed to persist grid state" });
    }
  });
}

export const gridStateFile = (root: string): string => path.join(root, "grid-state.json");
