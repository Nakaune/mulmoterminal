// What a click on a file path in terminal output does. On the server's own desktop it reveals
// the path in the OS file manager — see the LOCAL FORK note in terminalFilePathLinkProvider for
// why this fork leaves the app to do it. Viewed from another machine that window would open
// where nobody is looking, so there the path opens in the app (see remoteFileOpen).
import { fileLinkTarget } from "./terminalFilePathLinkProvider";
import { revealPath } from "./revealPath";
import { isViewedRemotely, servingTargetFor } from "./remoteFileOpen";
import { tryOpenInPane } from "./filesPaneOpener";
import { filesGotoFile } from "./useFilesView";
import { currentHome } from "./useAppConfig";

export interface ClickedPathContext {
  /** Every live session's directory — the bases the raw route will serve from. */
  sessionCwds: () => string[];
  /** Where a reveal that could not run is reported. */
  onNotice?: (message: string) => void;
}

// Upstream's routing (the pane beside an enlarged cell, then the Files view for source, then a
// new tab through the file routes), fed a serving base that contains the path instead of the
// session's cwd.
//
// Synchronous on purpose: `window.open` only gets past a popup blocker while the click is still
// on the stack.
function openInApp(filePath: string, cwd: string, sessionCwds: string[]): void {
  const { base, rel } = servingTargetFor(filePath, cwd, currentHome(), sessionCwds);
  // The pane is rooted at the clicking cell's own directory, so only a path under it can go there.
  if (base === cwd && tryOpenInPane(rel, base)) return;
  const target = fileLinkTarget(rel, base);
  if (target.kind === "files") filesGotoFile(base, rel);
  else window.open(target.url, "_blank", "noopener,noreferrer");
}

// A reveal that could not run says so in the cell's own banner rather than a console nobody has
// open: the click is silent by nature (the window opens somewhere else, or it doesn't), so a
// failure has nothing else to show for itself.
export function openClickedFilePath(filePath: string, cwd: string, context: ClickedPathContext): void {
  if (isViewedRemotely(window.location.hostname)) return openInApp(filePath, cwd, context.sessionCwds());
  void revealPath(filePath, cwd).then((failure) => {
    if (failure) context.onNotice?.(failure);
  });
}
