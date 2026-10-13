// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { liveCodexRollout } from "../../../server/agents/codex-live-rollout.js";

const A = "01a0bf59-159a-7452-a328-b31ced08d39a";
const B = "01a0c76c-f4a0-7b02-aeb5-90d231e49100";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mt-live-rollout-"));
  dirs.push(dir);
  const root = path.join(dir, "sessions");
  const proc = path.join(dir, "proc");
  mkdirSync(root);
  mkdirSync(proc);
  const rollout = (id: string, source: unknown = "cli", base = root) => {
    mkdirSync(base, { recursive: true });
    const file = path.join(base, `rollout-test-${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, cwd: "/same", source } }) + "\n");
    return file;
  };
  const fd = (pid: number, number: number, file: string, flags = "0100001") => {
    const base = path.join(proc, String(pid));
    for (const d of ["fd", "fdinfo"]) mkdirSync(path.join(base, d), { recursive: true });
    symlinkSync(file, path.join(base, "fd", String(number)));
    writeFileSync(path.join(base, "fdinfo", String(number)), `flags:\t${flags}\n`);
  };
  const children = (pid: number, ids: number[]) => {
    const task = path.join(proc, String(pid), "task", String(pid));
    mkdirSync(task, { recursive: true });
    writeFileSync(path.join(task, "children"), ids.join(" "));
  };
  return { dir, root, proc, rollout, fd, children };
}

describe("liveCodexRollout", () => {
  it("uses the parent's writer even with a guardian and unrelated reader", () => {
    const f = fixture();
    f.fd(10, 3, f.rollout(A));
    f.fd(10, 4, f.rollout(B, { subagent: { other: "guardian" } }));
    f.fd(10, 5, f.rollout(B, "cli", path.join(f.root, "other")), "0100000");
    expect(liveCodexRollout(f.root, 10, f.proc)?.id).toBe(A);
  });
  it("follows a wrapper without choosing another same-cwd process", () => {
    const f = fixture();
    f.children(10, [11]);
    f.fd(11, 3, f.rollout(A));
    f.fd(99, 3, f.rollout(B));
    expect(liveCodexRollout(f.root, 10, f.proc)?.id).toBe(A);
  });
  it("does not descend into tools when the parent owns its conversation", () => {
    const f = fixture();
    f.children(10, [11]);
    f.fd(10, 3, f.rollout(A));
    f.fd(11, 3, f.rollout(B));
    expect(liveCodexRollout(f.root, 10, f.proc)?.id).toBe(A);
  });
  it("refuses ambiguous writers and files outside the configured session root", () => {
    const f = fixture();
    f.fd(10, 3, f.rollout(A));
    f.fd(10, 4, f.rollout(B));
    expect(liveCodexRollout(f.root, 10, f.proc)).toBeNull();
    f.fd(20, 3, f.rollout(A, "cli", path.join(f.dir, "outside")));
    expect(liveCodexRollout(f.root, 20, f.proc)).toBeNull();
    expect(liveCodexRollout(f.root, 999, f.proc)).toBeNull();
  });
});
