import { ref } from "vue";
import { ACTIVE_CLIENT_API, ACTIVE_CLIENT_CHANNEL, isActiveClient } from "../../common/activeClient";
import { syncClientId } from "./syncClientId";
import { usePubSub } from "./usePubSub";
import { freezeAll } from "./useTerminalConnections";
import { reportActiveTerminals } from "./useUnloadGuard";

// Sticky: once another tab has claimed, this one stays inert until the page is reloaded.
export const superseded = ref(false);

function supersede(): void {
  if (superseded.value) return;
  superseded.value = true;
  freezeAll();
  // The tab now in use owns the sessions, so closing this stale one must not raise the close warning.
  reportActiveTerminals("grid", 0);
}

async function claim(clientId: string): Promise<void> {
  try {
    await fetch(ACTIVE_CLIENT_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
  } catch {
    // A reconnect re-checks; a server that is down has nobody else active either.
  }
}

async function recheck(clientId: string): Promise<void> {
  if (superseded.value) return;
  try {
    const response = await fetch(ACTIVE_CLIENT_API);
    if (!response.ok) return;
    const value: unknown = await response.json();
    if (!isActiveClient(value) || superseded.value) return;
    if (value.clientId === null) await claim(clientId);
    else if (value.clientId !== clientId) supersede();
  } catch {
    // Try again on the next reconnect.
  }
}

// Newest tab wins: opening a tab claims the grid, and every other tab on any device goes inert.
// Call once from the app root; the state it sets is module-level so other composables can read it.
export function useActiveClient(): void {
  const clientId = syncClientId();
  const pubsub = usePubSub();
  pubsub.subscribe(ACTIVE_CLIENT_CHANNEL, (value) => {
    if (isActiveClient(value) && value.clientId !== null && value.clientId !== clientId) supersede();
  });
  pubsub.onReconnect(() => void recheck(clientId));
  void claim(clientId);
}
