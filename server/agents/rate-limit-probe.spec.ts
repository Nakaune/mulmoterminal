// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { startRateLimitProbe, probeArgs, PROBE_PROMPT, USAGE_COMMAND, USAGE_MENU_DELAY_MS, USAGE_POLL_MS, USAGE_WAIT_MS } from "./rate-limit-probe";
import { createRateLimitStore } from "./rate-limit-store";

const pty = (over: Partial<{ kill: () => void; onData: (listener: (chunk: string) => void) => void; write: (data: string) => void }> = {}) => ({
  kill: () => {},
  onData: () => {},
  write: () => {},
  ...over,
});

const deps = (over: Partial<Parameters<typeof startRateLimitProbe>[0]> = {}) => ({
  spawn: () => pty(),
  host: "localhost",
  port: 34567,
  cwd: "/tmp",
  sessionId: "s",
  onSettled: () => {},
  usageCacheFetchedAt_ms: () => null,
  ...over,
});

const SETTINGS_FILE = "/run/mulmoterminal/settings.json";

// The probe asks by ARGUMENT, never at the keyboard. Typing was timed against a fixed 4-second
// boot wait, and a TUI that is not accepting input yet discards the keystrokes — so on any host
// slow to start, the question was never asked and the gauge could only time out and back off
// (#1293). It also means the probe sends no Enter, which is what used to confirm the default
// choice of whatever dialog was up.
describe("probeArgs", () => {
  it("carries the question as claude's own prompt argument", () => {
    expect(probeArgs("sid", SETTINGS_FILE).at(-1)).toBe(PROBE_PROMPT);
  });

  it("keeps the session id we chose, so the transcript can be addressed by name", () => {
    expect(probeArgs("sid", SETTINGS_FILE)).toEqual(expect.arrayContaining(["--session-id", "sid"]));
  });

  it("points claude at the settings file carrying the reporting statusLine", () => {
    expect(probeArgs("sid", SETTINGS_FILE)).toEqual(expect.arrayContaining(["--settings", SETTINGS_FILE]));
  });

  // The probe uses no tools, so the user's MCP servers are pure startup cost — and an
  // unauthenticated one measurably delays the first API response, which is the whole budget here.
  it("loads none of the user's MCP configuration", () => {
    expect(probeArgs("sid", SETTINGS_FILE)).toContain("--strict-mcp-config");
  });
});

describe("startRateLimitProbe", () => {
  // The caller marks a probe in flight BEFORE calling this, so an escape here would leave that flag
  // set with nothing to clear it and the gauge would stop refreshing for the life of the process.
  // Every failure has to arrive as the ordinary "this probe reported nothing".
  it("reports settled instead of throwing when the spawn fails", () => {
    const onSettled = vi.fn();
    const { stop } = startRateLimitProbe(
      deps({
        onSettled,
        spawn: () => {
          throw new Error("claude is not installed");
        },
      }),
    );
    expect(onSettled).toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  // Which is what a missing `claude` looks like from here — no branch of its own, because there is
  // nothing different to do about it.
  it("settles exactly once even when stopped again", () => {
    const onSettled = vi.fn();
    const { stop } = startRateLimitProbe(deps({ onSettled }));
    stop();
    stop();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("kills the terminal it started when stopped", () => {
    const kill = vi.fn();
    const { stop } = startRateLimitProbe(deps({ spawn: () => pty({ kill }) }));
    stop();
    expect(kill).toHaveBeenCalled();
  });

  // A PTY that has already exited makes kill() throw; stopping must still settle.
  it("still settles when killing throws", () => {
    const onSettled = vi.fn();
    const { stop } = startRateLimitProbe(
      deps({
        onSettled,
        spawn: () =>
          pty({
            kill: () => {
              throw new Error("already gone");
            },
          }),
      }),
    );
    expect(() => stop()).not.toThrow();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("spawns in the directory it was given, asking the question by argument", () => {
    const spawned: { args: string[]; cwd: string }[] = [];
    startRateLimitProbe(
      deps({
        cwd: "/work",
        spawn: (args, cwd) => {
          spawned.push({ args, cwd });
          return pty();
        },
      }),
    ).stop();
    expect(spawned[0].cwd).toBe("/work");
    expect(spawned[0].args.at(-1)).toBe(PROBE_PROMPT);
  });
});

// The terminal is the only evidence a stalled probe leaves, so it has to come back out — and the
// trust dialog has to be told apart from the silences nothing can name (#1293).
describe("what a settled probe carries out", () => {
  const settleWith = (chunks: readonly string[]) => {
    const outcome = vi.fn();
    const { stop } = startRateLimitProbe(
      deps({
        onSettled: outcome,
        spawn: () => pty({ onData: (listener) => chunks.forEach((chunk) => listener(chunk)) }),
      }),
    );
    stop();
    return outcome.mock.calls[0][0];
  };

  it("hands back what the probe's terminal showed", () => {
    expect(settleWith(["boot", "ing"]).screen).toBe("booting");
  });

  it("names the trust dialog when that is what is on screen", () => {
    expect(settleWith(["Quick safety check: Is this a project you created or one you trust?\n1. Yes, I trust this folder\n2. No, exit"]).stall).toBe(
      "trust-prompt",
    );
  });

  it("names nothing for an ordinary screen", () => {
    expect(settleWith(["Claude Code v2.1.220\n"]).stall).toBe("unknown");
  });

  // A spawn that never happened has no terminal to read, and must still settle — the caller's
  // in-flight flag is already set by the time this runs.
  it("settles with an empty screen when the spawn throws", () => {
    const outcome = vi.fn();
    startRateLimitProbe(
      deps({
        onSettled: outcome,
        spawn: () => {
          throw new Error("claude is not installed");
        },
      }),
    );
    expect(outcome.mock.calls[0][0]).toEqual({ stall: "unknown", screen: "" });
  });
});

// How index.ts wires the two together: the store says which agent reported windows, and that is
// what tells the probe its answer is in. Composed here rather than asserted on index.ts, because
// the bug was in the composition — `startRateLimitProbe`'s return value was simply dropped, so the
// PTY was held for the full 90-second timeout after the answer had already arrived, and
// `probing: true` kept every browser polling at seconds for the whole of it. The report now opens
// `/usage` before the probe goes (see "collecting /usage"), so "ends" means within USAGE_WAIT_MS at
// the latest, never the 90 seconds.
describe("ending the probe when its answer lands", () => {
  const windows = { fiveHour: { usedPercentage: 12, resetsAt_sec: 999 }, sevenDay: null };
  afterEach(() => vi.useRealTimers());

  // Half these tests assert the probe is STILL RUNNING, so nothing in them can stop it. The probe
  // holds a temp settings directory that only its own stop() removes, and it is created by the
  // production code — the test helper's registry never sees it (#1345). Left alone, each such test
  // leaves a `mt-ratelimit-` directory behind on every run.
  const running: (() => void)[] = [];
  afterEach(() => {
    running.splice(0).forEach((stopProbe) => stopProbe());
  });

  const wire = () => {
    vi.useFakeTimers();
    const killed = vi.fn();
    const onSettled = vi.fn();
    const typed: string[] = [];
    let probe: ReturnType<typeof startRateLimitProbe> | null = null;
    const store = createRateLimitStore({}, (_snapshot, agent) => {
      if (agent === "claude") probe?.reported();
    });
    probe = startRateLimitProbe(
      deps({
        onSettled: () => {
          probe = null;
          onSettled();
        },
        spawn: () => pty({ kill: killed, write: (data) => typed.push(data) }),
      }),
    );
    running.push(probe.stop);
    return { store, killed, onSettled, typed };
  };

  it("opens /usage as soon as a Claude report carries windows, and ends in bounded time", () => {
    const { store, killed, onSettled, typed } = wire();
    store.reportClaudeStatus({ limits: windows, afterApiResponse: true }, 1000);
    expect(typed).toEqual([USAGE_COMMAND]);
    expect(killed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(USAGE_WAIT_MS);
    expect(killed).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  // The status line also fires before the session's first API response, when `rate_limits` is not
  // there yet (statusline.ts). Ending on that would kill the probe just short of the one thing it
  // was spawned to collect.
  it("keeps going for a status line that carried none", () => {
    const { store, killed } = wire();
    store.reportClaudeStatus({ limits: null, afterApiResponse: false }, 1000);
    store.reportClaudeStatus({ limits: null, afterApiResponse: true }, 2000);
    expect(killed).not.toHaveBeenCalled();
  });

  // Codex is read from a file on every poll; it has nothing to do with this probe's lifetime.
  it("is not ended by a Codex reading", () => {
    const { store, killed } = wire();
    store.reportCodex(windows, 1000);
    expect(killed).not.toHaveBeenCalled();
  });
});

// The per-model weekly windows come from claude's own `/usage`, which the probe opens only once the
// status line has reported — the one moment the TUI is known to be listening (#1293 is why not
// earlier). It leaves as soon as claude has written its cache, and in bounded time if it never does.
describe("collecting /usage after the report", () => {
  afterEach(() => vi.useRealTimers());

  const probeWith = (over: Partial<Parameters<typeof startRateLimitProbe>[0]> = {}) => {
    vi.useFakeTimers();
    const typed: string[] = [];
    const kill = vi.fn();
    const onSettled = vi.fn();
    const handle = startRateLimitProbe(deps({ spawn: () => pty({ write: (data) => typed.push(data), kill }), onSettled, ...over }));
    return { handle, typed, kill, onSettled };
  };

  it("types nothing until the report arrives", () => {
    const { typed } = probeWith();
    vi.advanceTimersByTime(USAGE_WAIT_MS);
    expect(typed).toEqual([]);
  });

  it("opens /usage with the command first and Enter once the menu has had time to filter", () => {
    const { handle, typed } = probeWith();
    handle.reported();
    expect(typed).toEqual([USAGE_COMMAND]);
    vi.advanceTimersByTime(USAGE_MENU_DELAY_MS);
    expect(typed).toEqual([USAGE_COMMAND, "\r"]);
  });

  it("stops as soon as claude has rewritten its usage cache", () => {
    let stamp: number | null = 100;
    const { handle, kill, onSettled } = probeWith({ usageCacheFetchedAt_ms: () => stamp });
    handle.reported();
    vi.advanceTimersByTime(USAGE_POLL_MS * 2);
    expect(kill).not.toHaveBeenCalled();
    stamp = 200;
    vi.advanceTimersByTime(USAGE_POLL_MS);
    expect(kill).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("counts a cache that appears from nothing as landed", () => {
    let stamp: number | null = null;
    const { handle, kill } = probeWith({ usageCacheFetchedAt_ms: () => stamp });
    handle.reported();
    stamp = 1;
    vi.advanceTimersByTime(USAGE_POLL_MS);
    expect(kill).toHaveBeenCalled();
  });

  it("gives up on /usage in bounded time when the cache never changes", () => {
    const { handle, kill, onSettled } = probeWith();
    handle.reported();
    vi.advanceTimersByTime(USAGE_WAIT_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("asks only once however many reports carry the windows", () => {
    const { handle, typed } = probeWith();
    handle.reported();
    handle.reported();
    vi.advanceTimersByTime(USAGE_MENU_DELAY_MS);
    expect(typed).toEqual([USAGE_COMMAND, "\r"]);
  });

  it("settles instead of throwing when the terminal is already gone", () => {
    const { handle, onSettled } = probeWith({
      spawn: () =>
        pty({
          write: () => {
            throw new Error("EIO");
          },
        }),
    });
    expect(() => handle.reported()).not.toThrow();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does nothing after a stop", () => {
    const { handle, typed } = probeWith();
    handle.stop();
    handle.reported();
    expect(typed).toEqual([]);
  });
});
