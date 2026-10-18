/** Incrementally reads Codex's private OSC activity marker from raw PTY output. */
export type CodexTerminalState = "working" | "idle";

const MAX_PENDING = 4096;

export function createCodexTerminalActivityParser(onState: (state: CodexTerminalState | null) => void): (chunk: string) => void {
  let pending = "";

  return (chunk: string) => {
    pending += chunk;
    while (pending.length) {
      const start = pending.indexOf("\u001b]");
      if (start < 0) {
        pending = pending.endsWith("\u001b") ? "\u001b" : "";
        return;
      }
      if (start > 0) pending = pending.slice(start);

      const bel = pending.indexOf("\u0007", 2);
      const st = pending.indexOf("\u001b\\", 2);
      let end = -1;
      let terminatorLength = 0;
      if (bel >= 0 && (st < 0 || bel < st)) {
        end = bel;
        terminatorLength = 1;
      } else if (st >= 0) {
        end = st;
        terminatorLength = 2;
      }

      if (end < 0) {
        if (pending.length > MAX_PENDING) pending = "";
        return;
      }

      const body = pending.slice(2, end);
      if (body.startsWith("7501;") && body.endsWith(":app=codex")) {
        const marker = body.slice(5, -10);
        if (marker === "state=working") onState("working");
        else if (marker === "state=idle") onState("idle");
        else if (marker.startsWith("state=")) onState(null);
      }
      pending = pending.slice(end + terminatorLength);
    }
  };
}
