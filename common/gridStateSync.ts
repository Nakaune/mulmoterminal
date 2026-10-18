import { isRecord } from "./isRecord.js";

export const GRID_STATE_API = "/api/grid-state";
export const GRID_STATE_CHANNEL = "grid-state";

export interface GridStateSnapshot {
  revision: number;
  state: unknown | null;
  updatedBy: string | null;
}

export interface GridStateUpdate {
  baseRevision: number;
  state: unknown;
  clientId: string;
}

export function isGridStateSnapshot(value: unknown): value is GridStateSnapshot {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (value.state === null || isRecord(value.state)) &&
    (value.updatedBy === null || typeof value.updatedBy === "string")
  );
}
