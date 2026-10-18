import { describe, it, expect } from "vitest";
import { alignLoopbackHost } from "../../../src/utils/loopbackLink";

describe("alignLoopbackHost", () => {
  // The case this exists for: a dev server's printed URL, clicked from the tunnelled browser.
  it("spells a localhost link the way the tunnelled page is spelled", () => {
    expect(alignLoopbackHost("http://localhost:8103/study.html?layout=together", "127.0.0.1")).toBe("http://127.0.0.1:8103/study.html?layout=together");
  });

  // The desktop is served from `localhost` and both spellings reach it, so nothing moves there.
  it("leaves the link alone on the desktop", () => {
    expect(alignLoopbackHost("http://localhost:8103/x", "localhost")).toBe("http://localhost:8103/x");
  });

  // A real host serves 34567 and nothing else — rewriting into it would break every other port.
  it("leaves the link alone when the page is served from a real host", () => {
    expect(alignLoopbackHost("http://localhost:8103/x", "host.example.ts.net")).toBe("http://localhost:8103/x");
  });

  // Only the loopback NAME is ambiguous; everything else means what it says.
  it("does not touch a link to another machine", () => {
    expect(alignLoopbackHost("https://github.com/x/y", "127.0.0.1")).toBe("https://github.com/x/y");
  });

  it("does not touch a link that is already an IP literal", () => {
    expect(alignLoopbackHost("http://127.0.0.1:8103/x", "127.0.0.1")).toBe("http://127.0.0.1:8103/x");
  });

  // A scheme that is not http(s) is not ours to rewrite, and a non-URL must survive untouched
  // rather than come back as the string "undefined".
  it("passes through other schemes and unparseable input", () => {
    expect(alignLoopbackHost("ssh://localhost/x", "127.0.0.1")).toBe("ssh://localhost/x");
    expect(alignLoopbackHost("not a url", "127.0.0.1")).toBe("not a url");
  });
});
