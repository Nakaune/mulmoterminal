// @vitest-environment node
import { describe, it, expect } from "vitest";
import { openDirCommands, revealFileCommands } from "../../../server/files/open-dir.js";

describe("openDirCommands", () => {
  it("uses `open` on macOS", () => {
    expect(openDirCommands("darwin", false)).toEqual([{ cmd: "open" }]);
  });
  it("uses `explorer` on Windows", () => {
    expect(openDirCommands("win32", false)).toEqual([{ cmd: "explorer" }]);
  });
  it("falls back to `xdg-open` elsewhere (Linux)", () => {
    expect(openDirCommands("linux", false)).toEqual([{ cmd: "xdg-open" }]);
  });
  // WSL has no Linux file manager to reveal anything in, so the folder belongs to Windows
  // Explorer — which needs the path in its own form (#1447).
  it("uses Windows Explorer, and a Windows path, on WSL", () => {
    expect(openDirCommands("linux", true)[0]).toEqual({ cmd: "explorer.exe", windowsPath: true });
  });
  // Detection is a guess (a kernel name, or environment variables a service may not have), so a
  // wrong one must cost an ENOENT and a retry — never the feature.
  it("still tries xdg-open after Explorer, so a wrong WSL guess degrades", () => {
    expect(openDirCommands("linux", true).map((c) => c.cmd)).toEqual(["explorer.exe", "xdg-open"]);
  });
});

describe("revealFileCommands", () => {
  const argvFor = (platform: NodeJS.Platform, wsl: boolean, target: string): string[][] =>
    revealFileCommands(platform, wsl).map((c) => [c.cmd, ...(c.args ? c.args(target) : [target])]);

  // The file must be SELECTED, never opened: `explorer.exe file.dart` hands it to whatever
  // program Windows associates with .dart, and clicking a path an agent printed must not run
  // anything.
  it("selects the file rather than opening it, on Windows and on WSL", () => {
    expect(argvFor("win32", false, "C:\\proj\\a.ts")).toEqual([["explorer", "/select,C:\\proj\\a.ts"]]);
    expect(argvFor("linux", true, "\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts")[0]).toEqual([
      "explorer.exe",
      "/select,\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts",
    ]);
  });

  it("uses `open -R` on macOS", () => {
    expect(argvFor("darwin", false, "/Users/me/proj/a.ts")).toEqual([["open", "-R", "/Users/me/proj/a.ts"]]);
  });

  // xdg-open has no "select" — the containing folder is the closest a Linux desktop gets, and
  // opening the FILE with it would be the association launch this deliberately avoids.
  it("falls back to the containing folder with xdg-open", () => {
    expect(argvFor("linux", false, "/home/me/proj/a.ts")).toEqual([["xdg-open", "/home/me/proj"]]);
    expect(argvFor("linux", true, "/home/me/proj/a.ts")[1]).toEqual(["xdg-open", "/home/me/proj"]);
  });

  // Same reason openDirCommands keeps one: WSL detection is a guess, so a wrong one costs an
  // ENOENT and a retry rather than the feature.
  it("still tries xdg-open after Explorer on WSL", () => {
    expect(revealFileCommands("linux", true).map((c) => c.cmd)).toEqual(["explorer.exe", "xdg-open"]);
  });

  // The Windows path conversion is the dir opener's rule too, and both sides must agree: the
  // `/select,` argument is built from the WINDOWS form, which only happens if the flag is set.
  it("asks for the Windows form of the path on WSL", () => {
    expect(revealFileCommands("linux", true)[0].windowsPath).toBe(true);
  });
});
