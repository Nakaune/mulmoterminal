// The user-defined keyboard shortcuts, in `~/.mulmoterminal/config.json` under `keymap`.
//
// There are NO defaults: an absent or empty `keymap` means the shortcuts are OFF. Every
// binding is something the user opted into, because any key this claims is a key the
// terminal underneath stops receiving — that trade is the user's to make, not ours.
//
// The server sanitizes and persists it; the browser matches keydowns against it. One
// definition here so the accepted syntax can't drift between the two.
//
//   "keymap": { "zoom-next": "PageDown", "zoom-prev": "Shift+PageUp" }

// Actions a key can be bound to. Adding one here is all it takes for the config to accept it.
import { isRecord } from "./isRecord.js";

export const KEYMAP_ACTIONS = [
  "zoom-toggle",
  "zoom-next",
  "zoom-prev",
  "next-attention",
  "review-toggle",
  "terminal-new",
  "terminal-new-adjacent",
  "terminal-close",
  "copy",
  "paste",
] as const;
export type KeymapAction = (typeof KEYMAP_ACTIONS)[number];

export const isKeymapAction = (value: unknown): value is KeymapAction => typeof value === "string" && KEYMAP_ACTIONS.some((action) => action === value);

// action -> binding string. Absent action = unbound = that shortcut does nothing.
// Actions the GRID's key handler must never claim, because they are decided inside the terminal
// instead (see terminalClipboard.ts). One `keymap` block stays the user's single place to bind a
// key; only the dispatch differs, and it has to:
//
//   - The grid handler ends every match with preventDefault(). For `paste` that is fatal — the
//     browser's own paste is what actually inserts the text, and cancelling the keydown cancels
//     it. xterm implements paste as a `paste` DOM listener, not a key binding.
//   - `copy` must fall through to the terminal when there is NO selection, so Ctrl+C still sends
//     ^C. A handler that has already swallowed the key cannot change its mind.
export const TERMINAL_SCOPED_ACTIONS: readonly KeymapAction[] = ["copy", "paste"];

// A key that puts BYTES into the focused terminal instead of running an app action (#1005) —
// Cmd+Right as Ctrl+E for end-of-line, say, or Alt+B for word-back.
//
// A LIST, where every action above is a single field, because the two are shaped differently:
// an action is one behaviour that a key is pointed at, while every send binding carries its own
// payload. `{ "send": "\u0005" }` could only ever name one key.
//
// `bytes` goes to the PTY verbatim. Control characters are written the way JSON writes them
// (`"\u0005"` is Ctrl+E); nothing here interprets or re-escapes them.
export interface SendBinding {
  key: string;
  bytes: string;
}

export type Keymap = Partial<Record<KeymapAction, string>> & { send?: SendBinding[] };

// A parsed binding. `key` is matched against `KeyboardEvent.key` exactly as the browser
// reports it, so it is case-sensitive for printable characters ("a" and "A" differ, the
// latter implying Shift).
export interface KeyBinding {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

// Modifier spellings accepted in a binding string, mapped to the flag they set. "Cmd",
// "Command" and "Meta" are the same modifier; "Option" is macOS's name for Alt.
const MODIFIERS: Record<string, keyof Omit<KeyBinding, "key">> = {
  shift: "shift",
  alt: "alt",
  option: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
};

// Parse "Shift+PageUp" into its parts, or null when the string is malformed (empty, no
// key left after the modifiers, an unknown modifier, or a duplicate one). Callers treat
// null as "unbound" rather than throwing: a typo in a hand-edited config must cost the
// user that one shortcut, never the app.
export function parseKeyBinding(input: string): KeyBinding | null {
  const parts = input.split("+").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === "")) return null;
  const key = parts[parts.length - 1];
  if (key === undefined) return null; // unreachable: parts.length was checked above
  const binding: KeyBinding = { key, shift: false, alt: false, ctrl: false, meta: false };
  for (const part of parts.slice(0, -1)) {
    const flag = MODIFIERS[part.toLowerCase()];
    if (!flag || binding[flag]) return null; // unknown, or named twice
    binding[flag] = true;
  }
  // A lone modifier ("Shift") binds nothing usable.
  return MODIFIERS[key.toLowerCase()] ? null : binding;
}

// The structural shape of a keydown a binding is matched against. A real KeyboardEvent
// satisfies it, and so does a plain test object — no DOM dependency.
export interface KeymapKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

// Every modifier must match exactly, so a binding on "PageDown" does NOT fire for
// Shift+PageDown — that keystroke stays with the terminal (xterm's scrollback) unless the
// user binds it too.
export const matchesBinding = (binding: KeyBinding, e: KeymapKeyEvent): boolean =>
  e.key === binding.key && e.shiftKey === binding.shift && e.altKey === binding.alt && e.ctrlKey === binding.ctrl && e.metaKey === binding.meta;

// The action this keydown is bound to, or null. Bindings that fail to parse are skipped.
export function actionForKey(keymap: Keymap, e: KeymapKeyEvent): KeymapAction | null {
  for (const action of KEYMAP_ACTIONS) {
    const raw = keymap[action];
    if (raw === undefined) continue;
    const binding = parseKeyBinding(raw);
    if (binding && matchesBinding(binding, e)) return action;
  }
  return null;
}

const isSendBinding = (value: unknown): value is SendBinding => isRecord(value) && typeof value.key === "string" && typeof value.bytes === "string";

// The bytes this keydown should put into the terminal, or null when it is not a send binding.
//
// Only reachable for keys the GRID did not claim: its handler listens on `window` in the capture
// phase and calls stopPropagation(), so an action and a send binding on one keystroke is not a
// race — the action always wins and the send silently never fires. validateKeymap warns about it
// for that reason.
//
// First match wins, so a keystroke listed twice uses the earlier entry.
export function sendBytesFor(keymap: Keymap, e: KeymapKeyEvent & { type: string; isComposing?: boolean }): string | null {
  if (e.type !== "keydown" || e.isComposing) return null;
  for (const entry of keymap.send ?? []) {
    const binding = parseKeyBinding(entry.key);
    if (binding && matchesBinding(binding, e)) return entry.bytes;
  }
  return null;
}

// What is wrong with one `keymap` entry. `fatal` separates a typo the user clearly meant to
// work (a binding we cannot parse — the shortcut would silently never fire) from an action
// name we simply do not know, which is what a config written for a NEWER version looks like
// and must stay loadable.
export interface KeymapProblem {
  action: string;
  binding: unknown;
  reason: string;
  fatal: boolean;
}

// Report everything wrong with a `keymap`, for a caller that wants to tell the user instead
// of quietly dropping entries. Pure: the caller decides whether to warn, throw, or exit.
export function validateKeymap(input: unknown): KeymapProblem[] {
  if (input === undefined || input === null) return [];
  if (typeof input !== "object" || Array.isArray(input)) {
    return [{ action: "keymap", binding: input, reason: "`keymap` must be an object of action -> key binding", fatal: true }];
  }
  const entries = Object.entries(input);
  // A claim on one keystroke. `rank` is DISPATCH order, so the winner can be named: every action
  // outranks every send binding, because the grid's handler runs in the capture phase and stops
  // the event before the terminal — see sendBytesFor.
  const bound = new Map<string, Claim[]>();
  const claim = (parsed: KeyBinding, entry: Claim): void => {
    const key = canonicalBinding(parsed); // as PARSED: "Shift+PageUp" and "shift+pageup" are one keystroke
    bound.set(key, [...(bound.get(key) ?? []), entry]);
  };
  const problems = entries.flatMap(([action, binding]): KeymapProblem[] => {
    if (action === "send") return sendProblems(binding, claim);
    if (!isKeymapAction(action)) {
      return [{ action, binding, reason: `unknown action (known: ${KEYMAP_ACTIONS.join(", ")}, send)`, fatal: false }];
    }
    if (typeof binding !== "string") return [{ action, binding, reason: "binding must be a string", fatal: true }];
    const parsed = parseKeyBinding(binding);
    if (parsed === null) {
      return [{ action, binding, reason: 'unparseable key binding — expected e.g. "PageDown" or "Shift+PageUp"', fatal: true }];
    }
    claim(parsed, { label: action, binding, rank: KEYMAP_ACTIONS.indexOf(action) });
    return [];
  });
  return [...problems, ...duplicateWarnings(bound)];
}

interface Claim {
  label: string;
  binding: string;
  rank: number;
}

// Everything wrong with the `send` list, claiming the keystrokes that are well-formed.
//
// Fatal throughout, for the reason the module header gives: a send binding is invisible until
// the key is pressed, so a dropped one is indistinguishable from a shortcut that "doesn't work".
// Empty `bytes` is fatal too — it would take the key away from the terminal and put nothing back.
function sendProblems(input: unknown, claim: (parsed: KeyBinding, entry: Claim) => void): KeymapProblem[] {
  if (!Array.isArray(input)) {
    return [{ action: "send", binding: input, reason: "`send` must be an array of { key, bytes }", fatal: true }];
  }
  return input.flatMap((entry, i): KeymapProblem[] => {
    const label = `send[${i}]`;
    if (!isSendBinding(entry)) return [{ action: label, binding: entry, reason: "expected { key: string, bytes: string }", fatal: true }];
    const parsed = parseKeyBinding(entry.key);
    if (parsed === null) {
      return [{ action: label, binding: entry.key, reason: 'unparseable key binding — expected e.g. "Cmd+ArrowRight"', fatal: true }];
    }
    if (entry.bytes === "") {
      return [{ action: label, binding: entry.key, reason: "`bytes` is empty — the key would be taken from the terminal and nothing sent", fatal: true }];
    }
    // Ranked after every action, matching who actually wins (see the `bound` comment above).
    claim(parsed, { label, binding: entry.key, rank: KEYMAP_ACTIONS.length + i });
    return [];
  });
}

// Two claims on one keystroke: only one can fire, so the others silently never work.
//
// The winner is the one DISPATCH picks, not the one written first in the config file. Reporting
// the config-order winner would name the wrong entry whenever the two orders disagree, which is
// worse than not naming one.
function duplicateWarnings(bound: Map<string, Claim[]>): KeymapProblem[] {
  return [...bound.values()].flatMap((claims) => {
    if (claims.length < 2) return [];
    const [winner, ...losers] = [...claims].sort((a, b) => a.rank - b.rank);
    if (!winner) return []; // unreachable: claims.length >= 2 was checked above
    return losers.map(({ label, binding }) => ({
      action: label,
      binding,
      reason: `same keystroke as \`${winner.label}\` — only \`${winner.label}\` will fire`,
      fatal: false,
    }));
  });
}

// A binding's identity as a keystroke, for spotting two actions that claim the same one.
const canonicalBinding = (b: KeyBinding): string => `${b.shift ? "S" : ""}${b.alt ? "A" : ""}${b.ctrl ? "C" : ""}${b.meta ? "M" : ""}|${b.key}`;

// Keep only known actions bound to a parseable, non-empty string. Unknown keys and
// malformed bindings are dropped rather than rejecting the whole map, matching how the
// rest of the config treats one bad entry.
export function sanitizeKeymap(input: unknown): Keymap {
  if (!isRecord(input)) return {};
  const entries = Object.entries(input).filter(
    (entry): entry is [KeymapAction, string] => isKeymapAction(entry[0]) && typeof entry[1] === "string" && parseKeyBinding(entry[1]) !== null,
  );
  const send = sanitizeSendBindings(input.send);
  return { ...Object.fromEntries(entries), ...(send.length ? { send } : {}) };
}

// An entry survives only if it names a parseable key AND carries bytes to send. An empty `send`
// is dropped entirely rather than kept as `[]`, so an absent and an emptied list look the same
// to everything downstream.
const sanitizeSendBindings = (input: unknown): SendBinding[] =>
  Array.isArray(input) ? input.filter(isSendBinding).filter((entry) => entry.bytes !== "" && parseKeyBinding(entry.key) !== null) : [];
