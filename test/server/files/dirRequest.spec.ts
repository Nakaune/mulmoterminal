// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDirRequest, resolveLocalPathRequest } from "../../../server/files/dirRequest.js";

// A minimal Response that records the status + json it was sent, enough to assert
// which guard branch fired.
function fakeRes() {
  const sent: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { res: res as unknown as Response, sent };
}

// method + path as Express would set them: the origin guard applies the same rule the central
// gate does, which never judges a safe method. Both callers of resolveDirRequest are POSTs.
function reqFor(body: unknown, origin?: string): Request {
  return { method: "POST", path: "/api/open-dir", headers: { origin }, body } as unknown as Request;
}

const allowAll = () => true;

describe("resolveDirRequest", () => {
  it("returns the directory for an allowed origin + absolute existing dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-dirreq-"));
    try {
      const { res, sent } = fakeRes();
      expect(resolveDirRequest(reqFor({ path: dir }), res, allowAll)).toBe(dir);
      expect(sent.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a forbidden origin with 403 and does not read the body", () => {
    const { res, sent } = fakeRes();
    expect(resolveDirRequest(reqFor({ path: "/tmp" }), res, () => false)).toBeNull();
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({ error: "forbidden origin" });
  });

  it("rejects a missing path with 400", () => {
    const { res, sent } = fakeRes();
    expect(resolveDirRequest(reqFor({}), res, allowAll)).toBeNull();
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: "absolute path required" });
  });

  it("rejects a relative path with 400", () => {
    const { res, sent } = fakeRes();
    expect(resolveDirRequest(reqFor({ path: "relative/dir" }), res, allowAll)).toBeNull();
    expect(sent.status).toBe(400);
  });

  it("rejects a non-object body with 400", () => {
    const { res, sent } = fakeRes();
    expect(resolveDirRequest(reqFor("not-an-object"), res, allowAll)).toBeNull();
    expect(sent.status).toBe(400);
  });

  it("rejects an absolute path that is a file, not a directory, with 400", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-dirreq-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "x");
    try {
      const { res, sent } = fakeRes();
      expect(resolveDirRequest(reqFor({ path: file }), res, allowAll)).toBeNull();
      expect(sent.status).toBe(400);
      expect(sent.body).toEqual({ error: "not a directory" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-existent absolute path with 404", () => {
    const { res, sent } = fakeRes();
    expect(resolveDirRequest(reqFor({ path: path.join(tmpdir(), "mt-does-not-exist-xyz") }), res, allowAll)).toBeNull();
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ error: "directory not found" });
  });
});

describe("resolveLocalPathRequest", () => {
  it("accepts a file and says it is not a directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-dirreq-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "x");
    try {
      const { res, sent } = fakeRes();
      expect(resolveLocalPathRequest(reqFor({ path: file }), res, allowAll)).toEqual({ path: file, isDirectory: false });
      expect(sent.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a directory too", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-dirreq-"));
    try {
      const { res } = fakeRes();
      expect(resolveLocalPathRequest(reqFor({ path: dir }), res, allowAll)).toEqual({ path: dir, isDirectory: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A path an agent PRINTS is as often relative to the session's dir as absolute, and only the
  // server knows what it names on this filesystem.
  it("resolves a relative path against an absolute cwd in the body", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-dirreq-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "x");
    try {
      const { res } = fakeRes();
      expect(resolveLocalPathRequest(reqFor({ path: "a.txt", cwd: dir }), res, allowAll)).toEqual({ path: file, isDirectory: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An absolute path is taken as it stands even when a cwd is supplied — a sibling worktree or a
  // `~/.claude/…` path is exactly what the file manager is for, and containing it to the cwd is
  // what the in-app routes do (and why they refuse those paths).
  it("keeps an absolute path outside the cwd", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "mt-dirreq-out-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "mt-dirreq-cwd-"));
    try {
      const { res } = fakeRes();
      expect(resolveLocalPathRequest(reqFor({ path: outside, cwd }), res, allowAll)).toEqual({ path: outside, isDirectory: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a relative path with no cwd to resolve it against", () => {
    const { res, sent } = fakeRes();
    expect(resolveLocalPathRequest(reqFor({ path: "src/main.ts" }), res, allowAll)).toBeNull();
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: "absolute path required" });
  });

  it("rejects a forbidden origin with 403", () => {
    const { res, sent } = fakeRes();
    expect(resolveLocalPathRequest(reqFor({ path: "/tmp" }), res, () => false)).toBeNull();
    expect(sent.status).toBe(403);
  });

  it("rejects a non-existent path with 404", () => {
    const { res, sent } = fakeRes();
    expect(resolveLocalPathRequest(reqFor({ path: path.join(tmpdir(), "mt-does-not-exist-xyz") }), res, allowAll)).toBeNull();
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ error: "path not found" });
  });
});
