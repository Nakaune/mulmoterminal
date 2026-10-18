import { isRecord } from "./isRecord.js";

export const ACTIVE_CLIENT_API = "/api/active-client";
export const ACTIVE_CLIENT_CHANNEL = "active-client";
export const ACTIVE_CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// The one browser tab (on any device) that is allowed to drive the shared grid. Null until some
// tab claims it after a server start.
export interface ActiveClient {
  clientId: string | null;
}

export function isActiveClient(value: unknown): value is ActiveClient {
  return isRecord(value) && (value.clientId === null || (typeof value.clientId === "string" && ACTIVE_CLIENT_ID_RE.test(value.clientId)));
}
