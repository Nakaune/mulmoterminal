import type { Request, Response } from "express";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../../common/isRecord.js";
import { requestOriginAllowed } from "../routes/same-origin-guard.js";
import { expandTilde } from "./pathContainment.js";

/** A local path a POST names, and which kind it turned out to be. */
export interface LocalPathTarget {
  path: string;
  isDirectory: boolean;
}

// The guards every POST { path, cwd? } body shares: same-origin, and a path that resolves to
// an ABSOLUTE one. `~/…` is expanded, and a relative path is joined onto `cwd` when the body
// carries an absolute one — which is how a path an agent PRINTED (`src/main.ts`) resolves,
// since the terminal's clickable paths are as often relative to the session's dir as absolute.
// Returns null after sending the matching error response.
function resolveRequestedPath(
  req: Request,
  res: Response,
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean,
): string | null {
  if (!requestOriginAllowed(req, isAllowedOrigin)) {
    res.status(403).json({ error: "forbidden origin" });
    return null;
  }
  const body = isRecord(req.body) ? req.body : {};
  const raw = typeof body.path === "string" && body.path ? expandTilde(body.path, os.homedir()) : "";
  const abs = absoluteForm(raw, typeof body.cwd === "string" ? body.cwd : "");
  if (!abs) {
    res.status(400).json({ error: "absolute path required" });
    return null;
  }
  return abs;
}

// An absolute path stands as it is; a relative one means what it would mean in `cwd`, and
// nothing at all when there is no absolute cwd to read it against. "" = no usable path.
function absoluteForm(raw: string, cwd: string): string {
  if (!raw) return "";
  if (path.isAbsolute(raw)) return raw;
  return path.isAbsolute(cwd) ? path.resolve(cwd, raw) : "";
}

// Validate a POST { path, cwd? } request that names a local directory: same-origin,
// absolute, existing. Returns the directory, or null after sending the matching
// error response — so the caller just does `const dir = resolveDirRequest(...); if (!dir) return;`.
// Used by the local-only /api/git-remote route, and by /api/open-dir once it knows the
// target is a directory.
export function resolveDirRequest(
  req: Request,
  res: Response,
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean,
): string | null {
  const dir = resolveRequestedPath(req, res, isAllowedOrigin);
  if (!dir) return null;
  try {
    if (!statSync(dir).isDirectory()) {
      res.status(400).json({ error: "not a directory" });
      return null;
    }
  } catch {
    res.status(404).json({ error: "directory not found" });
    return null;
  }
  return dir;
}

/** The same guards, but the path may name a FILE — which is what a clicked terminal path
 *  usually is. `isDirectory` tells the caller which one arrived, so a file can be revealed
 *  (selected in its folder) where a directory is opened. */
export function resolveLocalPathRequest(
  req: Request,
  res: Response,
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean,
): LocalPathTarget | null {
  const target = resolveRequestedPath(req, res, isAllowedOrigin);
  if (!target) return null;
  try {
    return { path: target, isDirectory: statSync(target).isDirectory() };
  } catch {
    res.status(404).json({ error: "path not found" });
    return null;
  }
}
