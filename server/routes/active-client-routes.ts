import { readFileSync } from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { ACTIVE_CLIENT_API, ACTIVE_CLIENT_CHANNEL, ACTIVE_CLIENT_ID_RE, isActiveClient, type ActiveClient } from "../../common/activeClient.js";
import { isRecord } from "../../common/isRecord.js";
import { writeFileAtomic } from "../files/atomic-write.js";

export interface ActiveClientStore {
  read(): ActiveClient;
  set(clientId: string): ActiveClient;
}

// Persisted when given a file, so a server restart does not empty it. Empty after a restart, every
// tab that reconnects sees "nobody" and claims, and whichever lands last wins — a forgotten tab on
// another machine can take the grid from the one in use. With the id kept, the reconnecting tabs
// re-read the same winner and the others go inert.
export function createActiveClientStore(file: string | null = null, write = writeFileAtomic): ActiveClientStore {
  let current: ActiveClient = { clientId: null };
  if (file) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isActiveClient(parsed)) current = parsed;
    } catch {
      // No file yet (or unreadable): nobody is active until a tab claims.
    }
  }
  return {
    read: () => current,
    set(clientId) {
      current = { clientId };
      if (file) write(file, `${JSON.stringify(current)}\n`).catch((err: unknown) => console.error("[active-client] failed to persist:", err));
      return current;
    },
  };
}

// Whether `clientId` may write shared state. Before any tab has claimed, everyone may — that is
// also how a browser still running a bundle from before this existed keeps working until reloaded.
export const mayWrite = (store: ActiveClientStore, clientId: string): boolean => {
  const active = store.read().clientId;
  return active === null || active === clientId;
};

export function mountActiveClientRoutes(app: Express, deps: { store: ActiveClientStore; publish: (channel: string, data: unknown) => void }): void {
  app.get(ACTIVE_CLIENT_API, (_req: Request, res: Response) => {
    res.json(deps.store.read());
  });

  app.post(ACTIVE_CLIENT_API, (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isRecord(body) || typeof body.clientId !== "string" || !ACTIVE_CLIENT_ID_RE.test(body.clientId)) {
      return res.status(400).json({ error: "invalid clientId" });
    }
    const next = deps.store.set(body.clientId);
    deps.publish(ACTIVE_CLIENT_CHANNEL, next);
    return res.json(next);
  });
}

export const activeClientFile = (root: string): string => path.join(root, "active-client.json");
