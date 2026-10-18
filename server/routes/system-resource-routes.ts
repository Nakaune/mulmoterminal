import os from "node:os";
import type { Express } from "express";

export interface SystemResourceReading {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}

const clampPercent = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

export interface CpuSample {
  total: number;
  idle: number;
}

export function cpuPercent(previous: CpuSample, current: CpuSample): number {
  const previousTotal = previous.total;
  const currentTotal = current.total;
  const deltaTotal = currentTotal - previousTotal;
  if (!Number.isFinite(deltaTotal) || deltaTotal <= 0) return 0;
  const idleDelta = Math.max(0, current.idle - previous.idle);
  return clampPercent(((deltaTotal - idleDelta) / deltaTotal) * 100);
}

const cpuSample = (): CpuSample =>
  os.cpus().reduce(
    (sample, cpu) => ({
      total: sample.total + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq,
      idle: sample.idle + cpu.times.idle,
    }),
    { total: 0, idle: 0 },
  );

export function systemResourceReading(previous: CpuSample, current: CpuSample, total: number, free: number): SystemResourceReading {
  const memoryTotalBytes = Number.isFinite(total) ? Math.max(0, total) : 0;
  const memoryFreeBytes = Number.isFinite(free) ? Math.min(memoryTotalBytes, Math.max(0, free)) : 0;
  const memoryUsedBytes = memoryTotalBytes - memoryFreeBytes;
  return {
    cpuPercent: cpuPercent(previous, current),
    memoryPercent: clampPercent(memoryTotalBytes > 0 ? (memoryUsedBytes / memoryTotalBytes) * 100 : 0),
    memoryUsedBytes,
    memoryTotalBytes,
  };
}

export interface SystemResourceRouteDeps {
  cpuSample: () => CpuSample;
  totalMemory: () => number;
  freeMemory: () => number;
}

const liveDeps: SystemResourceRouteDeps = {
  cpuSample,
  totalMemory: os.totalmem,
  freeMemory: os.freemem,
};

export function mountSystemResourceRoutes(app: Express, deps: SystemResourceRouteDeps = liveDeps): void {
  let previous = deps.cpuSample();
  app.get("/api/system-resources", (_req, res) => {
    const current = deps.cpuSample();
    const reading = systemResourceReading(previous, current, deps.totalMemory(), deps.freeMemory());
    previous = current;
    res.json(reading);
  });
}
