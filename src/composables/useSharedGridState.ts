import { onMounted, onUnmounted, watch, type Ref } from "vue";
import { GRID_STATE_API, GRID_STATE_CHANNEL, isGridStateSnapshot, type GridStateSnapshot } from "../../common/gridStateSync";
import { MAX_TERMINALS, parseGridState, type GridState } from "../components/gridTabs";
import { usePubSub } from "./usePubSub";

const CLIENT_ID_KEY = "grid_sync_client_id";
const SAVE_DELAY_MS = 80;

function syncClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

// Run the state through the same parser a reload uses. Command cells and an unfinished launch
// cell cannot be reattached by another browser, so they must not become part of the shared grid.
// Both directions keep the uids (see ParseGridStateOptions.keepUids): the uid is what every
// browser's mounted cell is keyed by, so it has to mean the same cell in every browser.
export function sharedGridPayload(state: GridState): GridState {
  return parseGridState(JSON.stringify(state), { keepUids: true }) ?? state;
}

const encoded = (state: GridState): string => JSON.stringify(sharedGridPayload(state));
const hasSession = (state: GridState): boolean => state.cells.some((cell) => cell.session !== null);

// What survives when this browser adopts another's snapshot.
//
// A cell with no session yet — the one the launcher is open in, right now, mid-launch — is kept OUT
// of the shared payload on purpose: no other browser could reattach it. So a snapshot can never
// carry it back, and assigning one straight over the local state DELETES the cell the user is
// working in. What fills the screen then is the snapshot's own zoom, which is another browser's
// cell running another browser's session: pick codex in a fresh cell while the other side writes,
// and an existing claude session takes over the view.
//
// The same is true one step later. The launch resolves, the cell now HAS a session, and this
// browser's write of it is still in its debounce — or loses the revision race — when the other
// browser's snapshot lands. That snapshot was written without ever seeing the new cell, so taking it
// whole deletes a session that was just started (it then exits unwatched) and puts the user back on
// the snapshot's zoom: their previous session.
//
// So adopting is a rebase, measured against `base` — the last snapshot this browser and the server
// agreed on. What this browser changed since then is replayed on top of the incoming one: sessions
// opened here are carried across, sessions closed here stay closed, and launch cells are carried as
// before. Everything else the snapshot says wins. With no base yet (nothing agreed), only launch
// cells are carried: there is no way to tell an edit made here from a cell the server dropped.
export function adoptSnapshot(local: GridState, incoming: GridState, base: GridState | null = null): GridState {
  const known = new Set(base?.cells.map((cell) => cell.session) ?? []);
  const kept = new Set(local.cells.map((cell) => cell.session));
  const offered = new Set(incoming.cells.map((cell) => cell.session));
  // Closed here since the agreed state: the snapshot still lists them only because it predates that.
  const closedHere = base ? [...known].filter((id) => id !== null && !kept.has(id)) : [];
  const cells = closedHere.length === 0 ? incoming.cells : incoming.cells.filter((cell) => !closedHere.includes(cell.session));
  const room = Math.max(MAX_TERMINALS - cells.length, 0);
  // Opened here since the agreed state (or still launching), and not already in the snapshot.
  const pending = local.cells
    .filter((cell) => cell.session === null || (base !== null && !known.has(cell.session) && !offered.has(cell.session)))
    .slice(0, room);
  const next =
    cells === incoming.cells ? incoming : { ...incoming, cells, expanded: cells.some((cell) => cell.uid === incoming.expanded) ? incoming.expanded : null };
  if (pending.length === 0) return next;
  const taken = new Set(next.cells.map((cell) => cell.uid));
  let nextUid = next.nextUid;
  // Keep each uid when the snapshot has not claimed it. The grid keys its cells by uid, so handing
  // a live cell a new one remounts it — and remounting a cell mid-launch drops the very connection
  // this is protecting. Only a genuine collision gets renumbered.
  const carried = pending.map((cell) => {
    if (!taken.has(cell.uid)) {
      taken.add(cell.uid);
      nextUid = Math.max(nextUid, cell.uid + 1);
      return cell;
    }
    const uid = nextUid++;
    taken.add(uid);
    return { ...cell, uid };
  });
  const zoomed = carried[pending.findIndex((cell) => cell.uid === local.expanded)];
  return { ...next, cells: [...next.cells, ...carried], nextUid, expanded: zoomed ? zoomed.uid : next.expanded };
}

class GridStateSync {
  private revision = 0;
  private authoritative: string | null = null;
  // The last grid this browser and the server agreed on — what `adoptSnapshot` measures local edits
  // against. Null until the first agreement.
  private base: GridState | null = null;
  private ready = false;
  private saving = false;
  private saveAgain = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeReconnect: (() => void) | null = null;
  private readonly state: Ref<GridState>;
  private readonly clientId: string;
  private readonly pubsub: ReturnType<typeof usePubSub>;

  constructor(state: Ref<GridState>, clientId: string, pubsub: ReturnType<typeof usePubSub>) {
    this.state = state;
    this.clientId = clientId;
    this.pubsub = pubsub;
  }

  private apply(snapshot: GridStateSnapshot): void {
    if (snapshot.revision < this.revision) return;
    this.revision = snapshot.revision;
    if (snapshot.state === null) {
      this.authoritative = null;
      this.base = null;
      return;
    }
    const parsed = parseGridState(JSON.stringify(snapshot.state), { keepUids: true });
    if (!parsed) return;
    const base = this.base;
    this.authoritative = encoded(parsed);
    this.base = parsed;
    // `adoptSnapshot`, not `parsed`: the payload cannot describe a cell that is still launching
    // here, nor one opened or closed here that has not been written yet, so a plain assignment
    // would throw those away along with the user's place in the grid.
    if (snapshot.updatedBy !== this.clientId && encoded(this.state.value) !== this.authoritative)
      this.state.value = adoptSnapshot(this.state.value, parsed, base);
  }

  private async save(): Promise<void> {
    if (!this.ready) return;
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    const payload = sharedGridPayload(this.state.value);
    const body = encoded(payload);
    // An empty remote browser must not win first-start migration over the localhost browser that
    // already owns sessions. Once a shared snapshot exists, closing the last session still syncs.
    if (this.authoritative === null && !hasSession(payload)) return;
    if (body === this.authoritative) return;

    this.saving = true;
    try {
      const response = await fetch(GRID_STATE_API, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: this.revision, state: payload, clientId: this.clientId }),
      });
      const value: unknown = await response.json();
      if (!isGridStateSnapshot(value)) return;
      if (response.ok) {
        if (value.revision >= this.revision) {
          this.revision = value.revision;
          this.authoritative = JSON.stringify(value.state);
          this.base = payload;
        }
      } else if (response.status === 409) {
        // The other browser wrote first. Its accepted revision is the source of truth; applying
        // it also stops this stale browser from retrying forever with the same rejected edit.
        this.apply(value);
      }
    } catch {
      // A reconnect re-fetches the authoritative revision. Do not spin on a server that is down.
    } finally {
      this.saving = false;
      if (this.saveAgain) {
        this.saveAgain = false;
        this.scheduleSave();
      }
    }
  }

  scheduleSave(): void {
    if (!this.ready || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, SAVE_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch(GRID_STATE_API);
      if (!response.ok) return;
      const value: unknown = await response.json();
      if (!isGridStateSnapshot(value)) return;
      this.apply(value);
    } finally {
      this.ready = true;
      this.scheduleSave();
    }
  }

  mount(): void {
    this.unsubscribe = this.pubsub.subscribe(GRID_STATE_CHANNEL, (value) => {
      if (!isGridStateSnapshot(value) || value.revision <= this.revision) return;
      this.apply(value);
      this.ready = true;
    });
    this.unsubscribeReconnect = this.pubsub.onReconnect(() => void this.refresh());
    void this.refresh();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribeReconnect?.();
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

export function useSharedGridState(state: Ref<GridState>): void {
  const sync = new GridStateSync(state, syncClientId(), usePubSub());
  watch(state, () => sync.scheduleSave(), { deep: true });
  onMounted(() => sync.mount());
  onUnmounted(() => sync.unmount());
}
