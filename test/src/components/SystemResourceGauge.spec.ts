import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import SystemResourceGauge from "../../../src/components/SystemResourceGauge.vue";

const resources = vi.hoisted(() => ({
  snapshot: {
    __v_isRef: true,
    value: null as null | {
      cpuPercent: number;
      memoryPercent: number;
      memoryUsedBytes: number;
      memoryTotalBytes: number;
    },
  },
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../../src/composables/useSystemResources", () => ({
  useSystemResources: () => resources,
}));

describe("SystemResourceGauge", () => {
  it("stays out of the header until the first reading arrives", () => {
    resources.snapshot.value = null;
    const wrapper = mount(SystemResourceGauge);
    expect(wrapper.find('[data-testid="system-resource-gauge"]').exists()).toBe(false);
    expect(resources.start).toHaveBeenCalled();
    wrapper.unmount();
    expect(resources.stop).toHaveBeenCalled();
  });

  it("shows rounded CPU and memory percentages with an accessible detail", () => {
    resources.snapshot.value = {
      cpuPercent: 12.4,
      memoryPercent: 67.6,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
    };
    const wrapper = mount(SystemResourceGauge);
    const gauge = wrapper.get('[data-testid="system-resource-gauge"]');

    expect(gauge.text()).toContain("CPU 12%");
    expect(gauge.text()).toContain("MEM 68%");
    expect(gauge.attributes("aria-label")).toBe("CPU 12% used (normal); memory 68% used (normal, 8.0 of 16.0 GiB)");
    expect(gauge.attributes("title")).toBe(gauge.attributes("aria-label"));
    wrapper.unmount();
  });

  // 危険域は 1 段では足りない。85% と 99% はどちらも「赤」だが、対応の緊急度が違う。
  // 段の境目そのものを押さえる — 下端の値を渡して、その段になることを見る。
  it.each([
    [69, "normal"],
    [70, "warning"],
    [85, "critical"],
    [92, "severe"],
    [97, "exhausted"],
    [100, "exhausted"],
  ])("calls %i%% %s", (percent, expected) => {
    resources.snapshot.value = { cpuPercent: percent, memoryPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 16 * 1024 ** 3 };
    const wrapper = mount(SystemResourceGauge);
    expect(wrapper.get('[data-testid="system-resource-gauge"]').attributes("aria-label")).toContain(`CPU ${percent}% used (${expected})`);
    wrapper.unmount();
  });

  const styleAt = (percent: number): string => {
    resources.snapshot.value = { cpuPercent: percent, memoryPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 16 * 1024 ** 3 };
    const wrapper = mount(SystemResourceGauge);
    const style = wrapper.get('[data-testid="system-resource-cpu"]').attributes("style") ?? "";
    wrapper.unmount();
    return style;
  };

  // 無段階であること。隣り合う値が同じ色になったら、そこに段ができている。
  it("changes colour continuously, with no step", () => {
    const seen = [87, 88, 89, 90].map(styleAt);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // 上へ行くほど塗る面積が増える。12px の文字で赤を並べても見分けられないので、強さを
  // 運んでいるのは色相ではなくこちら。alpha は連続量なので段は入らない。
  it("deepens the wash as it approaches 100%", () => {
    const alphaOf = (style: string): number => Number(/srgb, var\(--danger,#e5484d\) (\d+)%/.exec(style)?.[1] ?? "0");
    expect(alphaOf(styleAt(84))).toBe(0);
    expect(alphaOf(styleAt(90))).toBeGreaterThan(0);
    expect(alphaOf(styleAt(95))).toBeGreaterThan(alphaOf(styleAt(90)));
    expect(alphaOf(styleAt(100))).toBe(100);
  });

  // 静かな帯では何も言わない。太字も余白も色も付けず、他のツールバー文字と同じに見える。
  it("says nothing below the quiet threshold", () => {
    resources.snapshot.value = { cpuPercent: 40, memoryPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 16 * 1024 ** 3 };
    const wrapper = mount(SystemResourceGauge);
    const cpu = wrapper.get('[data-testid="system-resource-cpu"]');
    expect(cpu.classes()).not.toContain("font-semibold");
    expect(cpu.attributes("style")).toContain("background: transparent");
    wrapper.unmount();
  });

  it("colors warning and critical resource usage independently", () => {
    resources.snapshot.value = {
      cpuPercent: 85,
      memoryPercent: 70,
      memoryUsedBytes: 12 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
    };
    const wrapper = mount(SystemResourceGauge);
    const cpu = wrapper.get('[data-testid="system-resource-cpu"]');
    const memory = wrapper.get('[data-testid="system-resource-memory"]');

    // 色は class ではなく inline style へ移った (1 段ごとの class では連続を表せない)。
    // ここで見るのは「CPU と MEM が別々に色付けされる」こと。
    expect(cpu.classes()).toContain("font-semibold");
    expect(memory.classes()).toContain("font-semibold");
    expect(cpu.attributes("style")).not.toBe(memory.attributes("style"));
    expect(wrapper.get('[data-testid="system-resource-gauge"]').attributes("data-local-feature")).toBe("system-resource-usage-color");
    expect(wrapper.get('[data-testid="system-resource-gauge"]').attributes("aria-label")).toContain("CPU 85% used (critical)");
    expect(wrapper.get('[data-testid="system-resource-gauge"]').attributes("aria-label")).toContain("memory 70% used (warning");
    wrapper.unmount();
  });
});
