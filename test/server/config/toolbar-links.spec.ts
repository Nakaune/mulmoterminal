// @vitest-environment node
import { describe, it, expect } from "vitest";
import { sanitizeToolbarLinks, TOOLBAR_LINK_MAX } from "../../../server/config/app-config";
import { isToolbarLink } from "../../../common/toolbarLinks";

const link = (over: Record<string, unknown> = {}) => ({ label: "Heatmap", url: "http://localhost:34567/h.html", ...over });

describe("sanitizeToolbarLinks", () => {
  it("keeps a well-formed link, with and without an icon", () => {
    expect(sanitizeToolbarLinks([link(), link({ label: "Docs", url: "https://example.com/", icon: "book" })])).toEqual([
      { label: "Heatmap", url: "http://localhost:34567/h.html" },
      { label: "Docs", url: "https://example.com/", icon: "book" },
    ]);
  });

  // The url ends up in an `<a href>`, where `javascript:` runs on click. This is the one field
  // in the config that can execute, so a bad scheme is dropped rather than rendered.
  it.each(["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "not a url"])("drops %s", (url) => {
    expect(sanitizeToolbarLinks([link({ url })])).toEqual([]);
  });

  it("trims, and drops a link whose label is only spaces", () => {
    expect(sanitizeToolbarLinks([link({ label: "  Heatmap  " })])).toEqual([{ label: "Heatmap", url: "http://localhost:34567/h.html" }]);
    expect(sanitizeToolbarLinks([link({ label: "   " })])).toEqual([]);
  });

  // The label is the button's only identity (title + aria-label), so two of them is two buttons
  // nothing can tell apart.
  it("keeps the first of a repeated label", () => {
    const kept = sanitizeToolbarLinks([link({ url: "https://a.example/" }), link({ url: "https://b.example/" })]);
    expect(kept).toEqual([{ label: "Heatmap", url: "https://a.example/" }]);
  });

  // The toolbar is a fixed-width row shared with the view buttons and the gauges.
  it("stops at the cap", () => {
    const many = Array.from({ length: TOOLBAR_LINK_MAX + 3 }, (_, i) => link({ label: `L${i}` }));
    expect(sanitizeToolbarLinks(many)).toHaveLength(TOOLBAR_LINK_MAX);
  });

  it.each([null, undefined, "nope", {}])("says nothing for %o", (input) => {
    expect(sanitizeToolbarLinks(input)).toEqual([]);
  });
});

// The browser re-checks rather than trusting the server: the same list arrives over HTTP, and an
// old build or a proxy could hand back something else entirely.
describe("isToolbarLink", () => {
  it("agrees with the sanitizer about schemes", () => {
    expect(isToolbarLink(link())).toBe(true);
    expect(isToolbarLink(link({ url: "javascript:alert(1)" }))).toBe(false);
    expect(isToolbarLink({ label: "", url: "https://example.com/" })).toBe(false);
    expect(isToolbarLink({ url: "https://example.com/" })).toBe(false);
  });
});
