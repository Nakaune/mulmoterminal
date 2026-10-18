import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2] ?? process.cwd());
const checks = [
  ["index.html", "mulmoterminal-feature-review-waiting"],
  ["common/keymap.ts", '"review-toggle"'],
  ["src/components/gridTabs.ts", "reviewPending"],
  ["src/components/TerminalCell.vue", "cell-review-badge"],
  ["src/components/CockpitHeader.vue", "cockpit-review"],
  ["src/components/CockpitHeader.vue", "cockpit-pr"],
  ["server/session/last-turn.ts", "latestCodexPromptFromParsed"],
  ["server/session/last-turn.ts", "conversationTurnsFromCodexParsed"],
  ["server/session/session-reads.ts", 'agent === "codex"'],
  ["server/session/session-title.ts", 'agent === "codex"'],
  ["server/agents/codex-activity.ts", "explicitWorkdirs"],
  ["server/session/codex-activity-track.ts", "noteLiveCwd"],
  ["server/session/spawn-codex.ts", "codexActivityRolloutId"],
  ["server/session/codex-legacy-rollout.ts", "parseLegacyCodexRolloutId"],
  ["server/session/codex-activity-watch.ts", "onInitialBoundary"],
  ["src/components/SystemResourceGauge.vue", "system-resource-usage-color"],
  ["src/components/SystemResourceGauge.vue", "system-resource-cpu"],
  ["src/components/RateLimitGauge.vue", "rate-limit-usage-color"],
  ["src/components/RateLimitGauge.vue", "color-mix(in srgb"],
  // サーバ側の改造は bundle に出ないので、ここでしか落ちたことを検出できない。
  ["server/agents/codex-rate-limits.ts", "isPlanRateLimits"],
  ["server/session/spawn-codex.ts", "bindCodexRollout"],
  ["server/session/codex-rollout-binding.ts", "watchCodexIdentity"],
  ["server/session/codex-rollout-binding.ts", "liveCodexRollout"],
  ["server/agents/codex-user-turn.ts", "response_item"],
  ["server/session/session-reads.ts", "readCodexSummary"],
  ["server/session/session-title.ts", "readCodexSummary"],
  ["server/session/codex-summary.ts", "forEachJsonlRecordIn"],
  ["server/session/tool-store.ts", "createCodexPrReader"],
  ["server/session/codex-session-pr.ts", "forEachJsonlRecordIn"],
];
const dist = path.join(root, "dist", "assets");
if (fs.existsSync(dist)) {
  const js = fs
    .readdirSync(dist)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(dist, f), "utf8"))
    .join("\n");
  for (const token of ["cell-review-badge", "cell-review-toggle", "review-toggle", "system-resource-usage-color", "rate-limit-usage-color", "cockpit-pr"])
    if (!js.includes(token)) checks.push(["dist/assets/*.js", token]);
}
const missing = checks.filter(([file, token]) => !fs.readFileSync(path.join(root, file), "utf8").includes(token));
if (missing.length) {
  console.error("Local build missing required feature: " + missing.map(([f, t]) => `${f}: ${t}`).join(", "));
  process.exitCode = 1;
}
