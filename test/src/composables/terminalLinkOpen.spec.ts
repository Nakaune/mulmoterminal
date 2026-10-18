import { describe, it, expect, vi, afterEach } from "vitest";
import { openTerminalLink } from "../../../src/composables/useTerminalConnections";

// Both link paths (OSC 8 hyperlinks and WebLinksAddon's plain http(s) text) go through this one
// opener, so this is where "the rewrite is actually applied on click" is pinned down. The pure
// rule has its own spec; what is checked here is that the opener consults it at all.
const withHostname = (hostname: string) => {
  const original = window.location;
  Object.defineProperty(window, "location", { value: { ...original, hostname }, writable: true, configurable: true });
  return () => Object.defineProperty(window, "location", { value: original, writable: true, configurable: true });
};

afterEach(() => vi.restoreAllMocks());

describe("openTerminalLink", () => {
  it("opens a localhost link under the IP literal when the page is served from one", () => {
    const restore = withHostname("127.0.0.1");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openTerminalLink("http://localhost:8103/study.html");
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:8103/study.html", "_blank", "noopener,noreferrer");
    restore();
  });

  it("opens the link untouched on the desktop", () => {
    const restore = withHostname("localhost");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openTerminalLink("http://localhost:8103/study.html");
    expect(open).toHaveBeenCalledWith("http://localhost:8103/study.html", "_blank", "noopener,noreferrer");
    restore();
  });
});
