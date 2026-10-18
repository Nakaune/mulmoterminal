// @vitest-environment node
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { cpuPercent, mountSystemResourceRoutes, systemResourceReading, type CpuSample } from "../../../server/routes/system-resource-routes";

describe("system resource readings", () => {
  it("derives CPU use from cumulative time deltas", () => {
    expect(cpuPercent({ total: 100, idle: 40 }, { total: 200, idle: 65 })).toBe(75);
  });

  it("bounds unusable CPU deltas and resource percentages", () => {
    expect(cpuPercent({ total: 100, idle: 40 }, { total: 100, idle: 40 })).toBe(0);
    expect(cpuPercent({ total: 0, idle: 100 }, { total: 100, idle: 0 })).toBe(100);
    expect(systemResourceReading({ total: 0, idle: 0 }, { total: 100, idle: 50 }, 100, -20)).toEqual({
      cpuPercent: 50,
      memoryPercent: 100,
      memoryUsedBytes: 100,
      memoryTotalBytes: 100,
    });
  });
});

describe("GET /api/system-resources", () => {
  it("takes one CPU sample per request and reuses it as the next baseline", async () => {
    const samples: CpuSample[] = [
      { total: 100, idle: 40 },
      { total: 200, idle: 65 },
      { total: 300, idle: 115 },
    ];
    let sampleCalls = 0;
    const app = express();
    mountSystemResourceRoutes(app, {
      cpuSample: () => {
        const sample = samples[sampleCalls++];
        if (!sample) throw new Error("unexpected CPU sample");
        return sample;
      },
      totalMemory: () => 1000,
      freeMemory: () => 250,
    });

    const first = await request(app).get("/api/system-resources");
    const second = await request(app).get("/api/system-resources");

    expect(sampleCalls).toBe(3);
    expect(first.body).toEqual({ cpuPercent: 75, memoryPercent: 75, memoryUsedBytes: 750, memoryTotalBytes: 1000 });
    expect(second.body).toEqual({ cpuPercent: 50, memoryPercent: 75, memoryUsedBytes: 750, memoryTotalBytes: 1000 });
  });
});
