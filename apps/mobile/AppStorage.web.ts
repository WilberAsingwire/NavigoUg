/**
 * Browser storage adapter.
 *
 * Auth sessions are kept in sessionStorage so they are scoped to the current tab
 * and cleared when that browser tab is closed. This is not equivalent to native
 * encrypted SecureStore: browser JavaScript can access this value, so production
 * deployment must use HTTPS and strong XSS protections.
 *
 * UI preferences are non-sensitive and use localStorage for persistence.
 */
const volatileStorage = new Map<string, string>();

function getBrowserStorage(key: string): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return key === "navigo.session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export async function getItemAsync(key: string): Promise<string | null> {
  const storage = getBrowserStorage(key);
  if (storage) {
    try {
      const value = storage.getItem(key);
      if (value !== null) return value;
    } catch {
      // Fall back to in-memory storage when browser storage is restricted.
    }
  }
  return volatileStorage.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  const storage = getBrowserStorage(key);
  if (storage) {
    try {
      storage.setItem(key, value);
      volatileStorage.delete(key);
      return;
    } catch {
      // Keep the current tab functional if browser storage is unavailable.
    }
  }
  volatileStorage.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  const storage = getBrowserStorage(key);
  if (storage) {
    try {
      storage.removeItem(key);
    } catch {
      // Clear the in-memory copy below as a best-effort fallback.
    }
  }
  volatileStorage.delete(key);
}
