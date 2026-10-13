<script setup lang="ts">
// The expand/restore and close buttons every grid cell's header ends with — identical in
// the command, launcher and terminal cells, down to the labels and the glyphs, because they
// mean the same thing to the grid: one zooms this cell, the other retires it (#646 B3).
//
// What "close" DOES stays with the parent: TerminalCell's may hold a live session, so its
// handler confirms before tearing down. This emits the intent and never acts on it, so a
// cell can't lose its confirmation by adopting the shared buttons (#826).
//
// No `.stop` on the clicks: the enclosing header's zoom gesture already ignores anything
// inside a button (shouldZoomOnHeaderClick), and stopping here would only hide that.
import { computed } from "vue";
import { CELL_BTN, CELL_BTN_ACTIVE, CELL_BTN_DISABLEABLE, CELL_CLOSE_BTN } from "./cellChromeClasses";

const props = defineProps<{
  expanded: boolean;
  filesOpen?: boolean;
  // Which side pane this cell is showing, so each button can read as pressed. The three share
  // one slot beside the enlarged terminal, so at most one is ever pressed.
  rightPane?: "files" | "canvas" | "tools" | null | undefined;
  // Whether this cell's session actually has the drawing tools — i.e. whether its directory has
  // the `render` MCP group registered with Claude Code. False disables the button rather than
  // removing it: the pane would open empty, and that is worth SAYING rather than hiding.
  canvasAvailable?: boolean;
  // Whether this cell is set aside (#992). Present ONLY on a cell that can be parked — a session
  // terminal. Left undefined, the button is not rendered at all, which is how the command and
  // launcher cells opt out without declaring anything: an ephemeral run and an empty launch slot
  // have nothing to come back to.
  parked?: boolean | undefined;
  // The narrow layout keeps this row to what a phone can act on: the way back, and nothing else.
  // The panes it drops (files, canvas, tools) each need a second column the phone does not have —
  // they take the whole screen there, covering the terminal you opened the session to read — and
  // park and close act on a GRID the phone is not arranging. All of them stay one tap away on the
  // desktop, which is where that arranging happens.
  phone?: boolean;
}>();
const emit = defineEmits<{ (e: "toggle-expand" | "close" | "toggle-files" | "toggle-canvas" | "toggle-tools" | "toggle-park"): void }>();

// The unavailable case names the fix, not just the state: the registration is per directory and
// only read when a session starts, so it takes a restart even once switched on.
const canvasTitle = computed(() => {
  if (!props.canvasAvailable) return "No render MCP for this directory — turn on Canvas in the launcher, then restart this cell";
  return props.rightPane === "canvas" ? "Hide canvas" : "Show canvas";
});

// Pressed buttons get a DIFFERENT class string, not an extra one: the two carry competing `bg-*`
// utilities, and appending would leave which of them wins to Tailwind's output order.
//
// Which pane is open was only in `aria-pressed` and the tooltip before — true for a screen reader
// and for whoever hovers, invisible to everyone looking at the header.
const filesClass = computed(() => (props.filesOpen ? CELL_BTN_ACTIVE : CELL_BTN));
// A disabled Canvas cannot be the open pane, so the pressed style never has to survive `disabled:`.
const canvasClass = computed(() => (props.rightPane === "canvas" ? CELL_BTN_ACTIVE : CELL_BTN_DISABLEABLE));
const toolsClass = computed(() => (props.rightPane === "tools" ? CELL_BTN_ACTIVE : CELL_BTN));
// A different class string rather than an extra one, for the same reason as the panes above.
const parkClass = computed(() => (props.parked ? CELL_BTN_ACTIVE : CELL_BTN));
// The label says what the click DOES, and names the guarantee the user is buying: the cell stays
// open and keeps its history. That is the whole reason this exists instead of `/clear`.
const parkTitle = computed(() => (props.parked ? "Wake this terminal" : "Set aside (stays open, keeps its history)"));
</script>

<template>
  <button
    class="cell-btn"
    :class="CELL_BTN"
    :title="expanded ? 'Restore' : 'Expand'"
    :aria-label="expanded ? 'Restore terminal' : 'Expand terminal'"
    @click="emit('toggle-expand')"
  >
    <span class="material-symbols-outlined" aria-hidden="true">{{ expanded ? "close_fullscreen" : "open_in_full" }}</span>
  </button>
  <!-- Only while enlarged: the pane splits the enlarged cell's room, which a tiled cell or a
       filmstrip thumbnail does not have. After expand/restore so the first `.cell-btn` keeps
       meaning what it always did. -->
  <button
    v-if="expanded && !phone"
    class="cell-btn"
    :class="filesClass"
    :aria-pressed="!!filesOpen"
    :title="filesOpen ? 'Hide files' : 'Show files'"
    :aria-label="filesOpen ? 'Hide files' : 'Show files'"
    @click="emit('toggle-files')"
  >
    <span class="material-symbols-outlined" aria-hidden="true">folder_open</span>
  </button>
  <!-- Shown but DISABLED when this session has no render MCP: the pane would open empty and
       never fill, and hiding the button outright leaves nothing to explain why. The title is
       where the fix goes, since a disabled control is the moment someone asks. -->
  <button
    v-if="expanded && !phone"
    data-testid="cell-canvas-btn"
    class="cell-btn"
    :class="canvasClass"
    :disabled="!canvasAvailable"
    :aria-pressed="rightPane === 'canvas'"
    :title="canvasTitle"
    :aria-label="canvasTitle"
    @click="emit('toggle-canvas')"
  >
    <span class="material-symbols-outlined" aria-hidden="true">draw</span>
  </button>
  <button
    v-if="expanded && !phone"
    class="cell-btn"
    :class="toolsClass"
    :aria-pressed="rightPane === 'tools'"
    :title="rightPane === 'tools' ? 'Hide tools' : 'Show tools'"
    :aria-label="rightPane === 'tools' ? 'Hide tools' : 'Show tools'"
    @click="emit('toggle-tools')"
  >
    <span class="material-symbols-outlined" aria-hidden="true">build</span>
  </button>
  <!-- Before close on purpose: the two are the choice the user is making — set it aside, or end
       it — and the reversible one should not sit past the one that tears a session down. -->
  <button
    v-if="parked !== undefined && !phone"
    data-testid="cell-park-btn"
    class="cell-btn"
    :class="parkClass"
    :aria-pressed="parked"
    :title="parkTitle"
    :aria-label="parkTitle"
    @click="emit('toggle-park')"
  >
    <span class="material-symbols-outlined" aria-hidden="true">bedtime</span>
  </button>
  <button v-if="!phone" class="cell-btn cell-close" :class="CELL_CLOSE_BTN" title="Close terminal" aria-label="Close terminal" @click="emit('close')">
    <span class="material-symbols-outlined" aria-hidden="true">close</span>
  </button>
</template>
