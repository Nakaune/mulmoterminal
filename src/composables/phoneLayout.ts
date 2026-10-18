// Which layout the window gets: the desktop grid, or the phone's one-screen-at-a-time stack.
//
// The app had no notion of a small screen at all — not one media query — and the header alone
// puts twelve controls and three gauges on one row, so at 390px it renders as an illegible smear.
// The grid below it is worse: the cockpit roster and the enlarged terminal are SIDE BY SIDE, and
// neither half has room. Measured on a real 390x844 viewport before this existed.
//
// The rule is a width, not a user-agent string: what breaks is having two panes where there is
// room for one, and a narrow desktop window breaks in exactly the same way a phone does. It is
// also the only signal that stays true when the phone is turned, which a sniffed UA does not.
//
// A pointer query (`pointer: coarse`) is deliberately NOT part of it. A touchscreen laptop
// answers coarse and has 1400px to lay out; a phone in landscape is 844px wide and wants the
// desktop layout back. Both of those are the width's answer, and adding the pointer would
// override it with the less relevant fact.
import { computed, ref, type ComputedRef } from "vue";

// Below this, the roster (unreadable under ~260px) and the terminal (unusable under ~360px) plus
// a splitter no longer fit side by side. Above it the desktop layout is merely tight, which it
// has always been allowed to be.
export const PHONE_MAX_WIDTH_PX = 700;

export type LayoutOverride = "phone" | "desktop" | null;

/** `?layout=phone` / `?layout=desktop` — the escape hatch, and the way to see either layout from
 *  the other machine. Anything else is no opinion, so a typo falls back to the width rather than
 *  pinning the layout to whatever the typo happened to resemble. */
export function layoutOverrideFrom(search: string): LayoutOverride {
  const value = new URLSearchParams(search).get("layout");
  return value === "phone" || value === "desktop" ? value : null;
}

/** The decision itself, away from the window so the rule is testable without one. Inclusive at
 *  the boundary: 700px is a phone, 701px is not. */
export function isPhoneLayout(width: number, override: LayoutOverride): boolean {
  if (override !== null) return override === "phone";
  return width <= PHONE_MAX_WIDTH_PX;
}

// A module singleton, for the same reason cockpitLines is one: the width is a property of the
// WINDOW, not of any component, and a per-caller ref would mean a resize listener per caller —
// each of them re-running the same measurement to reach the same answer.
const width = ref(typeof window === "undefined" ? Number.MAX_SAFE_INTEGER : window.innerWidth);
const override = ref<LayoutOverride>(typeof window === "undefined" ? null : layoutOverrideFrom(window.location.search));
let listening = false;

// Attached once, on the first read, and never removed: the layout question outlives every
// component that asks it (the grid is mounted for the life of the page), so there is no unmount
// at which dropping it would be correct.
function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("resize", () => (width.value = window.innerWidth));
  // Turning the phone changes innerWidth without always firing `resize` in Safari.
  window.addEventListener("orientationchange", () => (width.value = window.innerWidth));
}

export function usePhoneLayout(): ComputedRef<boolean> {
  listen();
  return computed(() => isPhoneLayout(width.value, override.value));
}

/** Tests only: drive the singleton without a real window. */
export function setPhoneLayoutForTest(nextWidth: number, nextOverride: LayoutOverride = null): void {
  width.value = nextWidth;
  override.value = nextOverride;
}
