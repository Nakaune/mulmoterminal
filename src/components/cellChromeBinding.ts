import { computed, type ComputedRef } from "vue";
import type { RightPane } from "./gridCell";

// What each cell already receives: all four are GRID state (see GridCellProps), which is why every
// cell type forwards exactly the same set.
export interface CellChromeSource {
  expanded: boolean;
  filesOpen?: boolean | undefined;
  rightPane?: RightPane | null | undefined;
  canvasAvailable?: boolean | undefined;
  phone?: boolean | undefined;
}

// The two booleans are resolved rather than passed through as `boolean | undefined`: under
// `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to CellChromeButtons'
// `filesOpen?: boolean`, and it reads every one of them as a truthiness test — so absent and false
// were already the same answer there.
export interface CellChromeProps {
  expanded: boolean;
  filesOpen: boolean;
  rightPane: RightPane | null;
  canvasAvailable: boolean;
  phone: boolean;
}

export type CellChromeEvent = "toggle-expand" | "toggle-files" | "toggle-canvas" | "toggle-tools" | "close";

// Bound as two objects rather than spelled out in each template.
//
// The command, launcher and terminal cells wired the same four props and the same five events, and
// TerminalCell did it twice (its cockpit header and its normal header) — four copies that all had
// to agree, so adding a fifth button meant remembering every one of them.
//
// `close` is the one that genuinely differs: TerminalCell's confirms before tearing down a live
// session (#826). So it is a parameter rather than an assumption, and the default is the plain
// forward the other two want.
export function cellChromeBinding(
  source: CellChromeSource,
  emit: (event: CellChromeEvent) => void,
  close: () => void = () => emit("close"),
): { chromeProps: ComputedRef<CellChromeProps>; chromeEvents: Record<CellChromeEvent, () => void> } {
  return {
    chromeProps: computed(() => ({
      expanded: source.expanded,
      filesOpen: source.filesOpen ?? false,
      rightPane: source.rightPane ?? null,
      canvasAvailable: source.canvasAvailable ?? false,
      phone: source.phone ?? false,
    })),
    chromeEvents: {
      "toggle-expand": () => emit("toggle-expand"),
      "toggle-files": () => emit("toggle-files"),
      "toggle-canvas": () => emit("toggle-canvas"),
      "toggle-tools": () => emit("toggle-tools"),
      close,
    },
  };
}

// The other half of the same idea, for CellShell: a non-agent cell forwards every event the shell
// raises straight up to the grid, unchanged. One object so the two callers do not each re-spell
// seven identical handlers — which is exactly what CellShell was extracted to stop.
export type CellShellEvent = CellChromeEvent | "move";

export function cellShellEvents(emit: {
  (event: CellChromeEvent): void;
  (event: "move", dir: -1 | 1): void;
}): Record<CellChromeEvent, () => void> & { move: (dir: -1 | 1) => void } {
  return {
    "toggle-expand": () => emit("toggle-expand"),
    "toggle-files": () => emit("toggle-files"),
    "toggle-canvas": () => emit("toggle-canvas"),
    "toggle-tools": () => emit("toggle-tools"),
    close: () => emit("close"),
    move: (dir: -1 | 1) => emit("move", dir),
  };
}
