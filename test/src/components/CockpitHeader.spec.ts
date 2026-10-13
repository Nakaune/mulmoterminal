import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import CockpitHeader from "../../../src/components/CockpitHeader.vue";
import type { AttentionStatus } from "../../../src/components/attentionStatus";
import type { PrPhase, WorkPhase } from "../../../src/components/rosterPhase";

type Props = {
  status: AttentionStatus;
  agent: string;
  cwd: string | null;
  home: string | null;
  headerColor: string | null;
  headerTextColor: string | null;
  workPhase?: WorkPhase | null;
  phase?: PrPhase;
  pr?: number | null;
  prUrl?: string | null;
  reviewPending?: boolean;
  dirLength?: number;
};
const base: Props = { status: "idle", agent: "claude", cwd: "/home/me/proj", home: "/home/me", headerColor: null, headerTextColor: null };
const mountH = (over: Partial<Props> = {}, slot?: string) => mount(CockpitHeader, { props: { ...base, ...over }, slots: slot ? { default: slot } : {} });
const bar = (w: ReturnType<typeof mountH>) => w.get('[data-testid="cockpit-header"]');
const badge = (w: ReturnType<typeof mountH>) => w.get('[data-testid="cockpit-badge"]').text();

describe("CockpitHeader", () => {
  it("tints the bar with the configured header colour, and leaves it untinted when there is none", () => {
    expect(bar(mountH({ headerColor: "#123456" })).attributes("style")).toContain("--cell-header-bg: #123456");
    expect(bar(mountH({ headerColor: null })).attributes("style") ?? "").not.toContain("--cell-header-bg");
  });

  it("shows the roster status word for each status", () => {
    expect(badge(mountH({ status: "idle" }))).toBe("idle");
    expect(badge(mountH({ status: "working" }))).toBe("running");
    expect(badge(mountH({ status: "blocked" }))).toBe("waiting");
    expect(badge(mountH({ status: "done" }))).toBe("done");
  });

  it("shows the work phase word while working when it is known", () => {
    expect(badge(mountH({ status: "working", workPhase: "implementing" }))).toBe("editing");
    expect(badge(mountH({ status: "working", workPhase: "planning" }))).toBe("planning");
  });

  it("uses the planning tone and shows the user-owned review marker", () => {
    const planning = mountH({ status: "working", workPhase: "planning", reviewPending: true });
    expect(planning.get('[data-testid="cockpit-badge"]').classes()).toContain("bg-[#22d3ee]");
    expect(planning.get('[data-testid="cockpit-review"]').text()).toBe("review");
    expect(mountH({ reviewPending: false }).find('[data-testid="cockpit-review"]').exists()).toBe(false);
  });

  it("shows the PR phase pill only when there is a phase", () => {
    expect(mountH({ phase: "none" }).find('[data-testid="cockpit-phase"]').exists()).toBe(false);
    expect(mountH({ phase: "ready" }).find('[data-testid="cockpit-phase"]').exists()).toBe(true);
  });

  it("shows a clickable PR number, including merged work, and omits unknown PRs", async () => {
    const w = mountH({ pr: 977, prUrl: "https://github.com/acme/repo/pull/977", phase: "merged" });
    const link = w.get('[data-testid="cockpit-pr"]');
    expect(link.text()).toBe("#977");
    expect(link.attributes("href")).toBe("https://github.com/acme/repo/pull/977");
    const bubble = new MouseEvent("click", { bubbles: true, cancelable: true });
    const parentClick = vi.fn();
    w.element.addEventListener("click", parentClick);
    link.element.dispatchEvent(bubble);
    expect(parentClick).not.toHaveBeenCalled();
    await w.setProps({ pr: 978, prUrl: "https://github.com/acme/repo/pull/978", phase: "closed" });
    expect(w.get('[data-testid="cockpit-pr"]').text()).toBe("#978");
    expect(w.get('[data-testid="cockpit-pr"]').attributes("href")).toContain("/978");
    await w.setProps({ pr: null, prUrl: null, phase: "none" });
    expect(w.find('[data-testid="cockpit-pr"]').exists()).toBe(false);
    expect(mountH({ pr: null }).find('[data-testid="cockpit-pr"]').exists()).toBe(false);
  });

  it("tags codex cells and not claude ones", () => {
    expect(mountH({ agent: "codex" }).text()).toContain("codex");
    expect(mountH({ agent: "claude" }).text()).not.toContain("codex");
  });

  it("renders the directory and the trailing slot", () => {
    const w = mountH({ cwd: "/home/me/proj", home: "/home/me" }, '<button data-testid="slotted">x</button>');
    expect(w.text()).toContain("proj");
    expect(w.find('[data-testid="slotted"]').exists()).toBe(true);
  });

  it("clips the directory from the front, so the tail survives the roster's narrow column", () => {
    const dir = mountH({ cwd: "/home/me/work/nested/deep/proj", home: "/home/me" }).get('[data-testid="cockpit-dir"]');
    expect(dir.classes()).toContain("[direction:rtl]");
    expect(dir.classes()).toContain("truncate");
    // rtl flips the default alignment too, which would push a short path to the trailing edge.
    expect(dir.classes()).toContain("text-left");
    // rtl reorders punctuation unless the path text opts back into logical order.
    expect(dir.get("span").classes()).toContain("[unicode-bidi:plaintext]");
    // The full path moved from a `title` to the shared hover tip (#1235) — asserted end to end in
    // hoverTip.spec.ts. The attribute has to be gone, or the browser's own slow tooltip appears a
    // second time on top of it.
    expect(dir.attributes("title")).toBeUndefined();
  });
});
