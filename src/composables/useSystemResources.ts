import { ref } from "vue";
import { fetchWithTimeout } from "../utils/fetchWithTimeout";
import { isRecord } from "../../common/isRecord";

export interface SystemResourceSnapshot {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}
const snapshot = ref<SystemResourceSnapshot | null>(null);
let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
const REFRESH_MS = 5000;
const FETCH_TIMEOUT_MS = 4000;
const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const validBytes = (v: unknown): v is number => valid(v) && v >= 0;

async function load(): Promise<void> {
  try {
    const res = await fetchWithTimeout("/api/system-resources", { method: "GET" }, FETCH_TIMEOUT_MS);
    if (!res.ok) return;
    const data: unknown = await res.json();
    if (!isRecord(data) || !valid(data.cpuPercent) || !valid(data.memoryPercent) || !validBytes(data.memoryUsedBytes) || !validBytes(data.memoryTotalBytes))
      return;
    snapshot.value = {
      cpuPercent: Math.min(100, Math.max(0, data.cpuPercent)),
      memoryPercent: Math.min(100, Math.max(0, data.memoryPercent)),
      memoryUsedBytes: data.memoryUsedBytes,
      memoryTotalBytes: data.memoryTotalBytes,
    };
  } catch {
    // Preserve the last reading.
  }
}
function run(chain: number): void {
  void load().then(() => {
    if (watchers > 0 && chain === generation) timer = setTimeout(() => run(chain), REFRESH_MS);
  });
}

export function useSystemResources() {
  return {
    snapshot,
    start(): void {
      watchers++;
      if (watchers === 1) {
        generation++;
        run(generation);
      }
    },
    stop(): void {
      watchers = Math.max(0, watchers - 1);
      if (!watchers) {
        generation++;
        if (timer) clearTimeout(timer);
        timer = null;
      }
    },
  };
}
