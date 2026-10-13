import type { RolloutMeta } from "../agents/codex-session.js";

export interface CodexIdentityWatchDeps {
  readLive: () => RolloutMeta | null;
  isAlive: () => boolean;
  onChange: (meta: RolloutMeta) => void;
  sleep: (ms: number) => Promise<void>;
}

/** An idle terminal may write its first rollout hours after startup. Keep watching
 * the same process for its whole lifetime, including in-place resume changes.
 * A transient missing fd never erases a previously established identity. */
export async function watchCodexIdentity(deps: CodexIdentityWatchDeps): Promise<void> {
  let selected: RolloutMeta | null = null;
  while (deps.isAlive()) {
    const observed = deps.readLive();
    if (!deps.isAlive()) return;
    if (observed && (selected?.id !== observed.id || selected.file !== observed.file)) {
      selected = observed;
      deps.onChange(observed);
    }
    await deps.sleep(selected ? 5000 : 1000);
  }
}
