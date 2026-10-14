import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";

type ResolveCwd = (cwd: string) => Promise<{ ok: true; cwd: string } | { ok: false; message: string }>;

export function fingerprintTaskRelayBuild(root: string): string {
  const files = ["package.json"];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  for (const directory of ["server", "common", "plugins", "bin"]) collect(directory);
  const digest = createHash("sha256").update(process.version);
  files.sort((left, right) => left.localeCompare(right, "en"));
  for (const file of files)
    digest
      .update(file)
      .update("\0")
      .update(readFileSync(path.join(root, file)))
      .update("\0");
  return digest.digest("hex");
}

// This version ships and executes TypeScript through tsx. Cover the whole shipped
// server, including spawners and CLI startup, rather than only this HTTP adapter.
// Compute once at startup; a grant is paired with this process and its configured worktree.
function validOwnerConfig(repo: unknown, worktree: unknown): repo is string {
  return (
    typeof repo === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    typeof worktree === "string" &&
    path.isAbsolute(worktree) &&
    path.resolve(worktree) === worktree
  );
}

export async function taskRelayCapabilities(repo: unknown, worktree: unknown, resolveCwd: ResolveCwd, buildId: string | null) {
  if (!validOwnerConfig(repo, worktree) || !buildId || !/^[0-9a-f]{64}$/.test(buildId)) return null;
  if (typeof worktree !== "string" || !path.isAbsolute(worktree) || path.resolve(worktree) !== worktree) return null;
  const resolved = await resolveCwd(worktree);
  // A symlink alias must not claim to be the canonical worktree authorized by the receiver.
  if (!resolved.ok || resolved.cwd !== worktree) return null;
  return {
    schema: 1,
    spawn_endpoint: "/api/plugin/spawnBackgroundChat",
    cwd_enforced: true,
    repo,
    worktree,
    build_id: buildId,
  };
}

export function mountTaskRelayCapabilities(
  app: Express,
  resolveCwd: ResolveCwd,
  captureBuild = () => fingerprintTaskRelayBuild(fileURLToPath(new URL("../../", import.meta.url))),
): void {
  // Snapshot owner configuration and shipped-source fingerprint at server startup.
  // Environment changes and disk edits cannot activate or re-identify this process.
  const repo = process.env.MULMO_TASK_RELAY_REPO;
  const worktree = process.env.MULMO_TASK_RELAY_WORKTREE;
  let buildId: string | null = null;
  if (validOwnerConfig(repo, worktree)) {
    try {
      buildId = captureBuild();
    } catch {
      /* Remain unconfigured until restart. */
    }
  }
  app.get("/api/task-relay/capabilities", async (_req, res) => {
    const proof = await taskRelayCapabilities(repo, worktree, resolveCwd, buildId).catch(() => null);
    res.set("Cache-Control", "no-store");
    if (!proof) return res.status(503).json({ error: "task_relay_unconfigured" });
    return res.json(proof);
  });
}
