import { describe, expect, it } from "vitest";
import { codexActivityRolloutId } from "../../../server/session/spawn-codex.js";

describe("codexActivityRolloutId", () => {
  it("uses an explicit resume id only for a new process", () => {
    expect(codexActivityRolloutId("resume", false, "mapped")).toBe("resume");
    expect(codexActivityRolloutId("stale-browser", true, "mapped")).toBe("mapped");
    expect(codexActivityRolloutId("stale-browser", true, null)).toBeNull();
  });
  it("uses the persisted mapping for a surviving tmux reattach", () => {
    expect(codexActivityRolloutId(null, true, "mapped")).toBe("mapped");
  });
  it("does not use a mapping for a fresh session", () => {
    expect(codexActivityRolloutId(null, false, "mapped")).toBeNull();
  });
});
