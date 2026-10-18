// Integration check against the REAL xterm Terminal (not the unit mock): confirms that
// our cell reading + column mapping + link ranges agree with how xterm actually stores
// wide (CJK) glyphs and numbers its columns. This is the part the pure unit tests can't
// vouch for.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { Terminal } from "@xterm/xterm";
import { createFilePathLinkProvider } from "../../src/composables/terminalFilePathLinkProvider";
import type { ILink } from "@xterm/xterm";

// xterm's Terminal.open() reaches for browser APIs jsdom omits; stub the few it needs.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

async function writeLine(term: Terminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(text, resolve));
}

function provideLinks(term: Terminal, cwd: string | null, reveal: (filePath: string, cwd: string) => void = () => {}): ILink[] | undefined {
  const provider = createFilePathLinkProvider(term, () => cwd, reveal);
  let result: ILink[] | undefined;
  provider.provideLinks(1, (links) => {
    result = links;
  });
  return result;
}

describe("createFilePathLinkProvider against real xterm", () => {
  it("linkifies the path after CJK text and reveals it with the session cwd", async () => {
    const term = new Terminal({ cols: 120, rows: 10, allowProposedApi: true });
    term.open(document.createElement("div"));
    await writeLine(term, "添付（dir/a.gif）");

    const reveal = vi.fn();
    const links = provideLinks(term, "/Users/me/proj", reveal);
    if (!links) throw new Error("expected the provider to return links");
    expect(links).toHaveLength(1);

    const [link] = links;
    expect(link.text).toBe("dir/a.gif");
    // 添(1-2) 付(3-4) （(5-6) d(7)…f(15) — real xterm columns, 1-based inclusive.
    expect(link.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 15, y: 1 } });

    link.activate(new MouseEvent("click"), link.text);
    expect(reveal).toHaveBeenCalledWith("dir/a.gif", "/Users/me/proj");

    term.dispose();
  });

  // Every kind goes the same way now: the extension decided the route upstream, and in this
  // fork it decides nothing — a source file, a document and an image all reach the file manager.
  it("reveals every clicked path regardless of extension", async () => {
    const term = new Terminal({ cols: 120, rows: 10, allowProposedApi: true });
    term.open(document.createElement("div"));
    await writeLine(term, "see src/main.ts and docs/a.md and dir/a.gif");

    const reveal = vi.fn();
    const links = provideLinks(term, "/Users/me/proj", reveal);
    if (!links) throw new Error("expected the provider to return links");
    expect(links.map((l) => l.text)).toEqual(["src/main.ts", "docs/a.md", "dir/a.gif"]);

    links.forEach((link) => link.activate(new MouseEvent("click"), link.text));
    expect(reveal.mock.calls).toEqual([
      ["src/main.ts", "/Users/me/proj"],
      ["docs/a.md", "/Users/me/proj"],
      ["dir/a.gif", "/Users/me/proj"],
    ]);

    term.dispose();
  });

  it("provides no links when the session cwd is unknown", async () => {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    term.open(document.createElement("div"));
    await writeLine(term, "dir/a.gif");
    expect(provideLinks(term, null)).toBeUndefined();
    term.dispose();
  });
});
