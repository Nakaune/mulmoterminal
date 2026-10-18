<script setup lang="ts">
// The 5h / 7d windows, always on screen in the grid header (#387).
//
// Always visible rather than a hover tip, which is what #388 shipped and what this replaces: the
// point is to notice a window filling up WITHOUT going to look, because by the time you think to
// check you have usually already hit it. The reset times stay on hover — they answer the second
// question, not the first.
import { computed, onMounted, onUnmounted } from "vue";
import { useRateLimits } from "../composables/useRateLimits";
import { rateLimitReadout, gaugeTitle } from "../composables/rateLimitGauge";
import AgentMark from "./AgentMark.vue";

const { snapshot, start, stop } = useRateLimits();
onMounted(start);
onUnmounted(stop);

// The clock is read ONCE per reading, and everything derived from it comes out of the same pass:
// the figures, the hover text, and the decision to drop a window whose reset has gone by. Reading
// Date.now() separately in each of those let them disagree — a window could be dropped as expired
// while its own hover text still counted down.
//
// `probeNote` sits where the numbers would be, in the muted colour, because it is the same kind of
// information: "here is what we know about your usage" (#1011).
const view = computed(() => {
  const now_ms = Date.now();
  return { now_ms, ...rateLimitReadout(snapshot.value, now_ms) };
});
const gauges = computed(() => view.value.gauges);
const probeNote = computed(() => view.value.note);
const titleFor = (agent: "claude" | "codex") => gaugeTitle(agent, snapshot.value?.[agent] ?? null, view.value.now_ms);
const AGENT_COLORS = { claude: "#d97757", codex: "#10a37f" } as const;
const MIN_COLOR_PERCENT = 25;
const concise = (value: number): string => Number(value.toFixed(2)).toString();
const usageColor = (agent: "claude" | "codex", usedPercent: number): string => {
  const bounded = Math.min(100, Math.max(0, Math.round(usedPercent)));
  const colorPercent = MIN_COLOR_PERCENT + bounded * ((100 - MIN_COLOR_PERCENT) / 100);
  return `color-mix(in srgb, var(--text-muted) ${concise(100 - colorPercent)}%, ${AGENT_COLORS[agent]} ${concise(colorPercent)}%)`;
};
const colorStyle = (agent: "claude" | "codex", usedPercent: number) => ({ color: usageColor(agent, usedPercent) });
const highestPercent = (windows: { percent: number }[]): number => Math.max(...windows.map((window) => window.percent));
</script>

<template>
  <!-- Nothing at all until something reports: an agent that is not installed, is on API-key
       billing, or has not run yet all arrive here as an empty list, and an empty gauge would be
       one more thing to explain rather than information. -->
  <span
    v-if="probeNote"
    class="ml-1.5 inline-flex flex-none items-center border-l border-border pl-2.5 font-mono text-[12px] leading-none text-dim"
    role="note"
    :title="probeNote"
    data-testid="rate-limit-note"
    >claude usage n/a</span
  >
  <span
    v-for="gauge in gauges"
    :key="gauge.agent"
    class="ml-1.5 inline-flex flex-none items-center gap-1.5 border-l border-border pl-2.5"
    role="img"
    :aria-label="titleFor(gauge.agent)"
    :title="titleFor(gauge.agent)"
    data-local-feature="rate-limit-usage-color"
  >
    <AgentMark v-if="gauge.marked" :agent="gauge.agent" :style="colorStyle(gauge.agent, highestPercent(gauge.windows))" />
    <span
      v-for="window in gauge.windows"
      :key="window.label"
      class="font-mono text-[12px] leading-none"
      :style="colorStyle(gauge.agent, window.percent)"
      :data-testid="`rate-limit-${gauge.agent}-${window.label}`"
      aria-hidden="true"
      >{{ window.label }} {{ window.percent }}%</span
    >
  </span>
</template>
