// Recover a terminal's conversation from its writer, not from whichever rollout
// happened to appear last in a directory shared by several terminals.
import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { readSessionMeta, type RolloutMeta } from "./codex-session.js";

const numericNames = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((name) => /^\d+$/u.test(name));
  } catch {
    return [];
  }
};

function writerRollouts(proc: string, root: string): RolloutMeta[] {
  const found = new Map<string, RolloutMeta>();
  for (const fd of numericNames(path.join(proc, "fd"))) {
    try {
      const flags = /^flags:\s*([0-7]+)/mu.exec(readFileSync(path.join(proc, "fdinfo", fd), "utf8"));
      if (!flags?.[1] || (Number.parseInt(flags[1], 8) & 3) === 0) continue;
      const file = realpathSync(readlinkSync(path.join(proc, "fd", fd)));
      if (!file.startsWith(root + path.sep) || !path.basename(file).startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
      const meta = readSessionMeta(file);
      if (meta && file.endsWith(`${meta.id}.jsonl`)) found.set(meta.id, { ...meta, file });
    } catch {
      // A process can close a descriptor between listing and reading it.
    }
  }
  return [...found.values()];
}

function childrenOf(proc: string, pid: number): number[] {
  try {
    return readFileSync(path.join(proc, "task", String(pid), "children"), "utf8")
      .trim()
      .split(/\s+/u)
      .filter((value) => /^\d+$/u.test(value))
      .map(Number);
  } catch {
    return [];
  }
}

/** Linux/WSL process inspection. Walk wrappers breadth-first, never choose a
 * child when the terminal process itself owns a rollout. Only writable fds count:
 * an agent reading another conversation through a tool is not its owner. */
export function liveCodexRollout(root: string, pid: number, procRoot = "/proc"): RolloutMeta | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(root);
  } catch {
    return null;
  }
  let layer = [pid];
  const seen = new Set<number>();
  for (let depth = 0; depth < 6 && layer.length && seen.size < 64; depth++) {
    const found = new Map<string, RolloutMeta>();
    const next: number[] = [];
    const pending = [...new Set(layer)].filter((current) => !seen.has(current)).slice(0, 64 - seen.size);
    for (const current of pending) {
      seen.add(current);
      const proc = path.join(procRoot, String(current));
      for (const meta of writerRollouts(proc, resolvedRoot)) found.set(meta.id, meta);
      next.push(...childrenOf(proc, current));
    }
    if (found.size) return found.size === 1 ? ([...found.values()][0] ?? null) : null;
    layer = next;
  }
  return null;
}
