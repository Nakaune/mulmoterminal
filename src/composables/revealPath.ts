// Reveal a path in the OS file manager, through the local server — a browser tab cannot open a
// folder, but the server it is talking to can (POST /api/open-dir). A directory opens; a file
// opens its folder with the file selected.
//
// `cwd` is the session's directory, so a path an agent printed relative to it (`src/main.ts`)
// resolves the same way it would in that terminal. The server does the joining: only it knows
// what a path means on the host's filesystem.
//
// Returns the reason it did not happen, or null on success. The route answers only once an
// opener has actually STARTED, so a host with none (WSL with interop off, a bare Linux box with
// no `xdg-open`) says so rather than looking like a click that did nothing (#1447).
import { jsonBody } from "../jsonBody";
import { fetchWithTimeout } from "../utils/fetchWithTimeout";

export async function revealPath(targetPath: string, cwd: string | null): Promise<string | null> {
  try {
    const res = await fetchWithTimeout("/api/open-dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: targetPath, cwd }),
    });
    if (res.ok) return null;
    const body = await jsonBody(res);
    return typeof body.error === "string" && body.error.length > 0 ? body.error : `Could not reveal ${targetPath} (HTTP ${res.status}).`;
  } catch (e) {
    return `Could not reveal ${targetPath}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
