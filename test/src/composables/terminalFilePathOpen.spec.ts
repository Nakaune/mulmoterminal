import { describe, it, expect, vi, afterEach } from "vitest";

const filesGotoFile = vi.hoisted(() => vi.fn());
vi.mock("../../../src/composables/useFilesView", () => ({ filesGotoFile }));

import { openClickedFilePath } from "../../../src/composables/clickedFilePath";

const noSessions = { sessionCwds: (): string[] => [] };

// Where "a click on a path does the right thing for where you are sitting" is pinned down. The
// pure rules have their own spec (remoteFileOpen); what is checked here is that the click
// consults them — the reveal is a window on the SERVER's desktop, so taking it from another
// machine is a click that silently does nothing.
const withHostname = (hostname: string) => {
  const original = window.location;
  Object.defineProperty(window, "location", { value: { ...original, hostname }, writable: true, configurable: true });
  return () => Object.defineProperty(window, "location", { value: original, writable: true, configurable: true });
};

const stubFetch = () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  filesGotoFile.mockReset();
});

describe("openClickedFilePath", () => {
  it("reveals the path in the file manager on the desktop", () => {
    const restore = withHostname("localhost");
    const fetchMock = stubFetch();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openClickedFilePath("/home/me/other/docs/a.md", "/home/me/proj", noSessions);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/open-dir", expect.anything());
    expect(open).not.toHaveBeenCalled();
    expect(filesGotoFile).not.toHaveBeenCalled();
    restore();
  });

  it("opens a document outside the cwd in a new tab when viewed through a tunnel", () => {
    const restore = withHostname("127.0.0.1");
    const fetchMock = stubFetch();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openClickedFilePath("/home/me/other/docs/a.md", "/home/me/proj", noSessions);
    expect(open).toHaveBeenCalledWith("/api/files/browse/md?cwd=%2Fhome%2Fme%2Fother%2Fdocs&path=a.md", "_blank", "noopener,noreferrer");
    expect(fetchMock).not.toHaveBeenCalled();
    restore();
  });

  it("opens source in the Files view when viewed from a real hostname", () => {
    const restore = withHostname("host.example.ts.net");
    const fetchMock = stubFetch();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openClickedFilePath("src/main.ts", "/home/me/proj", noSessions);
    expect(filesGotoFile).toHaveBeenCalledWith("/home/me/proj", "src/main.ts");
    expect(open).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    restore();
  });

  it("opens an image under the cwd through the raw route", () => {
    const restore = withHostname("127.0.0.1");
    stubFetch();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openClickedFilePath("shots/a.png", "/home/me/proj", noSessions);
    expect(open).toHaveBeenCalledWith("/api/files/raw?cwd=%2Fhome%2Fme%2Fproj&path=shots%2Fa.png", "_blank", "noopener,noreferrer");
    restore();
  });

  // The raw route serves from live session directories only, so the click has to name one.
  it("serves an image outside the cwd from the live session that contains it", () => {
    const restore = withHostname("127.0.0.1");
    stubFetch();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openClickedFilePath("/home/me/other/shots/a.png", "/home/me/proj", { sessionCwds: () => ["/home/me/proj", "/home/me/other"] });
    expect(open).toHaveBeenCalledWith("/api/files/raw?cwd=%2Fhome%2Fme%2Fother&path=shots%2Fa.png", "_blank", "noopener,noreferrer");
    restore();
  });
});
