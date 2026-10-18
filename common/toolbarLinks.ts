// A link pinned to the APP toolbar, one click away from wherever you are.
//
// Neither of the two things it looks like. A `launcher` (config `launchers`) STARTS A CELL — it
// belongs in the launch form, and a link put there costs a terminal to open a page. A header
// `button` (config `buttons`) lives on ONE terminal's header and is scoped by `when`. This is app
// chrome: it has no session and no directory, so it sits beside the bell rather than inside a cell.
//
// Read-only from the browser's side: the settings UI does not edit these, so `config.json` (or a
// POST to /api/config) is where they are set.
import { isRecord } from "./isRecord.js";

export interface ToolbarLink {
  label: string;
  url: string;
  /** A Material Symbols name. Omitted falls back to a neutral glyph rather than nothing, so a
   *  link is never an invisible 30px gap. */
  icon?: string | undefined;
}

/** The glyph a link with no `icon` gets. */
export const TOOLBAR_LINK_FALLBACK_ICON = "link";

// The url goes into an `<a href>`, so the scheme is not the config's decision to make:
// `javascript:` there runs on click. Same rule as sessionPr.safeHttpsUrl, and http is allowed
// here because these point at localhost pages this app itself serves.
export function isSafeToolbarUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export const isToolbarLink = (value: unknown): value is ToolbarLink =>
  isRecord(value) &&
  typeof value.label === "string" &&
  value.label !== "" &&
  typeof value.url === "string" &&
  isSafeToolbarUrl(value.url) &&
  (value.icon === undefined || typeof value.icon === "string");
