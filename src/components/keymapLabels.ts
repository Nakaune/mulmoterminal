import { KEYMAP_ACTIONS, type Keymap, type KeymapAction } from "../../common/keymap";

// What each bindable action is called in the settings list.
//
// A full Record, not a lookup with a fallback: adding an action to KEYMAP_ACTIONS then fails to
// compile until it is named here, so a new shortcut can't ship invisible to the one screen that
// tells the user it exists.
const LABELS: Record<KeymapAction, string> = {
  "zoom-toggle": "Enlarge / collapse a terminal",
  "zoom-next": "Enlarge the next terminal",
  "zoom-prev": "Enlarge the previous terminal",
  "next-attention": "Jump to a terminal that needs you",
  "review-toggle": "Mark / clear this terminal for review",
  "terminal-new": "New terminal (at the end)",
  "terminal-new-adjacent": "New terminal next to this one",
  "terminal-close": "Close this terminal",
  // Only acts when the terminal has a selection; with none, the key reaches the shell as it
  // always did — which is what makes Ctrl+C a usable binding here without losing interrupt.
  copy: "Copy the terminal selection",
  paste: "Paste into the terminal",
};

export interface KeymapRow {
  action: KeymapAction;
  label: string;
  // The user's binding, or null when they haven't set one — shown as "Not set" rather than
  // hidden, since an unbound row is how someone discovers the action exists at all.
  binding: string | null;
}

export const keymapRows = (keymap: Partial<Record<KeymapAction, string>>): KeymapRow[] =>
  KEYMAP_ACTIONS.map((action) => ({ action, label: LABELS[action], binding: keymap[action] ?? null }));

// The `send` bindings, which have no fixed list to render: unlike an action, one exists only
// because the user wrote it, so an unbound row cannot be shown and there is nothing to show at
// all until they add one.
export interface SendRow {
  /** Stable and unique per row, for the list's `v-for` key. The binding string cannot serve:
   *  two entries may claim the same keystroke (validation warns, but the config still loads),
   *  and duplicate keys make Vue reuse DOM nodes across rows — one of the two would vanish from
   *  the very screen that is meant to show what is configured. */
  id: string;
  key: string;
  label: string;
}

// C0 control characters have no glyph, so printing `bytes` raw would render an invisible row —
// the caret spelling (`^E`) is how a terminal has always written them, and is what the user will
// recognise from Ctrl+E. DEL is 0x7f, one past the C0 block, and carries the same notation.
export function describeBytes(bytes: string): string {
  return [...bytes]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0x7f) return "^?";
      return code < 0x20 ? `^${String.fromCharCode(code + 0x40)}` : ch;
    })
    .join("");
}

export const sendRows = (keymap: Keymap): SendRow[] =>
  (keymap.send ?? []).map((entry, i) => ({ id: `${i}:${entry.key}`, key: entry.key, label: describeBytes(entry.bytes) }));
