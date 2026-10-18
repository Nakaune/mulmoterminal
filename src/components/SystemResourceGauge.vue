<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useSystemResources } from "../composables/useSystemResources";
const { snapshot, start, stop } = useSystemResources();
onMounted(start);
onUnmounted(stop);

const GIB = 1024 ** 3;
const gib = (bytes: number): string => (bytes / GIB).toFixed(1);
// 危険域は 1 段では足りない。85% と 99% はどちらも赤で、しかし「重い」と「もう倒れる」の
// 違いがある。上へ行くほど段を細かくしてある — 下は 15 ポイント幅、上は 3 ポイント幅。
const WARNING_PERCENT = 70;
const CRITICAL_PERCENT = 85;
const SEVERE_PERCENT = 92;
const EXHAUSTED_PERCENT = 97;

type Level = "normal" | "warning" | "critical" | "severe" | "exhausted";

const level = (percent: number): Level => {
  if (percent >= EXHAUSTED_PERCENT) return "exhausted";
  if (percent >= SEVERE_PERCENT) return "severe";
  if (percent >= CRITICAL_PERCENT) return "critical";
  if (percent >= WARNING_PERCENT) return "warning";
  return "normal";
};

// 色は段ではなく連続。85% と 99% を同じ赤で描くと、対応の緊急度が同じに見える。
//
// 2 つの連続量を重ねている。文字色は QUIET_PERCENT から 100% まで灰 → 琥珀 → 赤 → ほぼ白へ、
// 背景は WASH_PERCENT から 100% まで透明 → 赤へ。上端では「赤地に白抜き」になるが、そこへ
// 段差なしで着く。色相だけで強さを表すと、12px の文字では見分けられない — 塗る面積が
// 増えることのほうが視界の端で効く。
const QUIET_PERCENT = 60; // ここまでは何も言わない
const WASH_PERCENT = 85; // ここから背景が乗り始める
const TEXT_STOPS = ["#8b949e", "#e2b341", "#e5484d", "#ffe8e8"] as const;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const mix = (a: string, b: string, t: number): string => {
  const channel = (from: string, to: string, at: number): number =>
    Math.round(parseInt(from.slice(at, at + 2), 16) + (parseInt(to.slice(at, at + 2), 16) - parseInt(from.slice(at, at + 2), 16)) * t);
  return `#${[1, 3, 5].map((at) => channel(a, b, at).toString(16).padStart(2, "0")).join("")}`;
};

const rampColor = (percent: number): string => {
  const t = clamp01((percent - QUIET_PERCENT) / (100 - QUIET_PERCENT));
  const span = TEXT_STOPS.length - 1;
  const index = Math.min(Math.floor(t * span), span - 1);
  return mix(TEXT_STOPS[index] ?? "", TEXT_STOPS[index + 1] ?? "", t * span - index);
};

// 0 から始めて 100% で不透明。alpha は連続量なので、ここに段は入らない。
const washAlpha = (percent: number): number => clamp01((percent - WASH_PERCENT) / (100 - WASH_PERCENT));

const levelStyle = (percent: number): Record<string, string> => {
  const alpha = washAlpha(percent);
  return {
    color: rampColor(percent),
    background: alpha > 0 ? `color-mix(in srgb, var(--danger,#e5484d) ${Math.round(alpha * 100)}%, transparent)` : "transparent",
  };
};

// 太字と余白は連続にできない (0.5px の padding は無い) ので、静かな帯とそれ以外だけを分ける。
const levelClass = (percent: number): string => (percent >= QUIET_PERCENT ? "font-semibold rounded-[3px] px-1" : "");
const cpuLevel = computed(() => level(snapshot.value?.cpuPercent ?? 0));
const memoryLevel = computed(() => level(snapshot.value?.memoryPercent ?? 0));
const title = computed(() =>
  snapshot.value
    ? `CPU ${Math.round(snapshot.value.cpuPercent)}% used (${cpuLevel.value}); memory ${Math.round(snapshot.value.memoryPercent)}% used (${memoryLevel.value}, ${gib(snapshot.value.memoryUsedBytes)} of ${gib(snapshot.value.memoryTotalBytes)} GiB)`
    : "System resources unavailable",
);
</script>
<template>
  <span
    v-if="snapshot"
    class="ml-1.5 inline-flex flex-none items-center gap-2 border-l border-border pl-2.5 font-mono text-[12px] leading-none"
    role="img"
    :title="title"
    :aria-label="title"
    data-testid="system-resource-gauge"
    data-local-feature="system-resource-usage-color"
  >
    <span data-testid="system-resource-cpu" :class="levelClass(snapshot.cpuPercent)" :style="levelStyle(snapshot.cpuPercent)"
      >CPU {{ Math.round(snapshot.cpuPercent) }}%</span
    >
    <span data-testid="system-resource-memory" :class="levelClass(snapshot.memoryPercent)" :style="levelStyle(snapshot.memoryPercent)"
      >MEM {{ Math.round(snapshot.memoryPercent) }}%</span
    >
  </span>
</template>
