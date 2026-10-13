// A dev server prints `http://localhost:8103/…` because that is the name that reaches it on the
// machine it runs on. Click that link from a SECOND machine — one viewing this app through an
// SSH tunnel — and the word `localhost` is resolved on the tunnel's far side by Windows, which
// answers `::1` first. The dev servers here listen on `127.0.0.1` only, so the tab dies with
// ERR_SOCKET_NOT_CONNECTED while the very same page opens under its IPv4 literal.
//
// The page you are reading is the evidence of which spelling reaches this machine from where you
// sit: the desktop is served from `localhost`, the tunnelled browser from `127.0.0.1`. So spell
// the link's loopback host the way this app's own host is spelled, and nothing changes on the
// desktop — where both spellings work anyway.
//
// Deliberately narrow: `localhost` -> `127.0.0.1`, and nothing else. Rewriting to a real hostname
// (a Tailscale name, say) would send the click to a machine that serves port 34567 and nothing
// else, and the `::1` direction is not written here because no arrangement we have produces it —
// an untested branch that only ever runs on someone else's setup is worse than no branch.
const IPV4_LOOPBACK = "127.0.0.1";

export function alignLoopbackHost(uri: string, viewedHost: string): string {
  if (viewedHost !== IPV4_LOOPBACK) return uri;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return uri; // Not a URL we can reason about — hand it back untouched.
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return uri;
  if (url.hostname !== "localhost") return uri;
  url.hostname = IPV4_LOOPBACK;
  return url.toString();
}
