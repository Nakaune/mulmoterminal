// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRolloutTail, walkForNewest } from "./codex-rollout";

// A rollout is re-read on EVERY poll of the gauge, from a request handler, and the only thing
// wanted is the last `rate_limits` in it. Reading more than the tail is pure cost, repeated
// forever — which is what happened when the size stopped being passed and a Claude-sized default
// took over (#998).

describe("readRolloutTail", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mt-rollout-"));
    file = path.join(dir, "rollout.jsonl");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the end of a long rollout, not the whole of it", () => {
    const filler = `{"payload":{"junk":"${"x".repeat(4000)}"}}`;
    const lines = [...Array.from({ length: 2000 }, () => filler), '{"payload":{"marker":"last"}}'];
    writeFileSync(file, lines.join("\n"));
    expect(statSync(file).size).toBeGreaterThan(4 * 1024 * 1024); // bigger than the shared default

    const tail = readRolloutTail(file);

    expect(tail[tail.length - 1]).toContain("last");
    // Far fewer than the 2001 written: proof it stopped at a bound rather than taking the file.
    expect(tail.length).toBeLessThan(200);
  });

  it("returns everything when the file is smaller than the bound", () => {
    writeFileSync(file, ['{"a":1}', '{"b":2}'].join("\n"));
    expect(readRolloutTail(file)).toEqual(['{"a":1}', '{"b":2}']);
  });

  // Every caller wants "no recent reading" rather than an exception — the gauge already renders
  // an absent agent as absent.
  it("says nothing for a file that is not there", () => {
    expect(readRolloutTail(path.join(dir, "never-written.jsonl"))).toEqual([]);
  });
});

// The gauge no longer wants "the newest file" but "the newest few", because the busiest session
// can be spending a different budget than the one being shown (codex-rate-limits.ts). Order is the
// whole contract: the caller stops at the first file that answers, so a wrong order means an old
// reading wins over a current one.
describe("walkForNewest", () => {
  let root: string;

  const rollout = (relative: string, mtime_sec: number): string => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}");
    utimesSync(file, mtime_sec, mtime_sec);
    return file;
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mt-sessions-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns every rollout in the tree, newest first", () => {
    const older = rollout("2026/08/25/rollout-a.jsonl", 1_000_000);
    const newest = rollout("2026/08/27/rollout-c.jsonl", 3_000_000);
    const middle = rollout("2026/08/26/rollout-b.jsonl", 2_000_000);

    expect(walkForNewest(root, 9_000_000_000)).toEqual([newest, middle, older]);
  });

  it("ignores files that are not rollouts", () => {
    rollout("2026/08/27/notes.txt", 3_000_000);
    const real = rollout("2026/08/27/rollout-a.jsonl", 1_000_000);

    expect(walkForNewest(root, 9_000_000_000)).toEqual([real]);
  });

  it("says nothing for a tree that is not there", () => {
    expect(walkForNewest(path.join(root, "never-created"), 9_000_000_000)).toEqual([]);
  });
});
