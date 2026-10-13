import type { Express, Request } from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveLocalPathRequest } from "./dirRequest.js";
import { isWsl, toWindowsPath } from "./wsl.js";

export interface OpenDirCommand {
  cmd: string;
  /** The command is a Windows program, so it wants the Windows form of the path (WSL interop). */
  windowsPath?: boolean;
  /** The argv this opener wants for the target. Absent = the path on its own. */
  args?: (target: string) => string[];
}

// The native file-manager openers for a platform, best first. The commands are a fixed
// allowlist (never built from input); the directory is passed as a separate argv entry, so
// there's no shell and no injection surface.
//
// WSL is Explorer's job even though the platform is `linux`: the distro has no desktop of its
// own, and `xdg-open` there either doesn't exist or opens a Linux app nobody can see (#1447).
// `xdg-open` still follows it, so a host wrongly read as WSL — or a WSL with interop turned off —
// falls back to what a Linux desktop would have done instead of failing outright.
export function openDirCommands(platform: NodeJS.Platform, wsl: boolean): OpenDirCommand[] {
  if (platform === "win32") return [{ cmd: "explorer" }];
  if (platform === "darwin") return [{ cmd: "open" }];
  if (wsl) return [{ cmd: "explorer.exe", windowsPath: true }, { cmd: "xdg-open" }];
  return [{ cmd: "xdg-open" }];
}

// The same openers for a FILE, which is what a path clicked in terminal output usually names.
// The file is SELECTED in its folder rather than opened: clicking a path must never hand the
// file to whatever program the OS associates with its extension — that would turn reading a
// path an agent printed into running something.
//
// `xdg-open` has no "select"; the containing folder is the closest a Linux desktop gets, and it
// is the WSL fallback for the same reason openDirCommands keeps one (a host wrongly read as WSL,
// or WSL with interop off).
export function revealFileCommands(platform: NodeJS.Platform, wsl: boolean): OpenDirCommand[] {
  const select = (target: string): string[] => [`/select,${target}`];
  const parent = (target: string): string[] => [path.dirname(target)];
  if (platform === "win32") return [{ cmd: "explorer", args: select }];
  if (platform === "darwin") return [{ cmd: "open", args: (target) => ["-R", target] }];
  if (wsl)
    return [
      { cmd: "explorer.exe", windowsPath: true, args: select },
      { cmd: "xdg-open", args: parent },
    ];
  return [{ cmd: "xdg-open", args: parent }];
}

// Resolves null once the child is running, or the reason it could not start. The exit CODE is
// deliberately not waited for: `explorer.exe` returns 1 on a perfectly successful open, and the
// user is done with us the moment the window appears.
function spawnOpener(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => resolve(e.message));
    child.on("spawn", () => {
      child.unref();
      resolve(null);
    });
  });
}

/** The path this opener wants, or null when it cannot be expressed (so the caller skips it). */
const targetFor = (candidate: OpenDirCommand, dir: string): Promise<string | null> => (candidate.windowsPath ? toWindowsPath(dir) : Promise.resolve(dir));

interface OpenDirOptions {
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean;
}

// POST /api/open-dir { path, cwd? } — reveal an existing local path in the OS file manager.
// A directory opens; a FILE opens its folder with the file selected (never the file itself —
// see revealFileCommands). `path` may be relative to `cwd`, which is what a path clicked in
// terminal output usually is. The server runs locally, so this is how a browser tab (which
// can't touch the filesystem) opens a folder. Guarded by the same-origin check used for the
// sockets so a random website can't drive it.
//
// It answers only once an opener has actually STARTED. It used to answer `{ok:true}` first and
// log the failure to a console the user never sees, so a host without `xdg-open` reported success
// and revealed nothing (#1447).
export function mountOpenDirRoute(app: Express, { isAllowedOrigin }: OpenDirOptions) {
  app.post("/api/open-dir", async (req: Request, res) => {
    const requested = resolveLocalPathRequest(req, res, isAllowedOrigin);
    if (!requested) return;
    const { path: dir, isDirectory } = requested;
    const wsl = isWsl(process.platform, process.env);
    const attempts: string[] = [];
    for (const candidate of isDirectory ? openDirCommands(process.platform, wsl) : revealFileCommands(process.platform, wsl)) {
      const target = await targetFor(candidate, dir);
      if (target === null) {
        attempts.push(`${candidate.cmd}: wslpath could not translate ${dir}`);
        continue;
      }
      const failure = await spawnOpener(candidate.cmd, candidate.args ? candidate.args(target) : [target]);
      if (failure === null) return res.json({ ok: true });
      attempts.push(`${candidate.cmd}: ${failure}`);
    }
    res.status(500).json({ error: `could not open ${dir} [${attempts.join("; ")}]` });
  });
}
