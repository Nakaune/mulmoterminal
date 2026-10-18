const CLIENT_ID_KEY = "grid_sync_client_id";

// One id per browser tab (sessionStorage), shared by the grid sync and the active-client claim.
export function syncClientId(): string {
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
