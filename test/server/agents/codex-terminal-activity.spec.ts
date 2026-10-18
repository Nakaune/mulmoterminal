import { describe, expect, it, vi } from "vitest";
import { createCodexTerminalActivityParser } from "../../../server/agents/codex-terminal-activity.js";

describe("Codex terminal activity parser", () => {
  it("handles arbitrary chunk boundaries and ST/BEL terminators", () => {
    const states: ("working" | "idle" | null)[] = [];
    const parse = createCodexTerminalActivityParser((state) => states.push(state));
    parse("screen\u001b]7501;state=work");
    parse("ing:app=codex\u001b");
    parse("\\more\u001b]7501;state=idle:app=codex\u0007");
    expect(states).toEqual(["working", "idle"]);
  });

  it("ignores unrelated OSC and clears on unsupported Codex states", () => {
    const states: ("working" | "idle" | null)[] = [];
    const parse = createCodexTerminalActivityParser((state) => states.push(state));
    parse("\u001b]7502;state=working:app=codex\u0007\u001b]7501;state=working:app=other\u0007");
    parse("\u001b]7501;state=needs-input:app=codex\u001b\\");
    expect(states).toEqual([null]);
  });

  it("bounds an unterminated OSC without carrying it into later output", () => {
    const onState = vi.fn();
    const parse = createCodexTerminalActivityParser(onState);
    parse(`\u001b]7501;${"x".repeat(5000)}`);
    parse("tail\u001b]7501;state=idle:app=codex\u0007");
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith("idle");
  });
});
