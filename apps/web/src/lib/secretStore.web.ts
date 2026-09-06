/**
 * Web implementation of the secret store: `localStorage`, guarded for SSR /
 * static export the same way `prefStore.ts` is (module evaluation can happen
 * where `window` doesn't exist). Unlike `prefStore`, this is for the one
 * secret the app holds client-side — the owner token — so callers must not
 * be tempted to reuse `prefStore` for it.
 */
type SecretStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const memory = new Map<string, string>();

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export const secretStore: SecretStore = {
  getItem(key) {
    try {
      if (!hasWindow()) return memory.get(key) ?? null;
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  setItem(key, value) {
    try {
      if (!hasWindow()) {
        memory.set(key, value);
        return;
      }
      window.localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
  removeItem(key) {
    try {
      if (!hasWindow()) {
        memory.delete(key);
        return;
      }
      window.localStorage.removeItem(key);
    } catch {
      memory.delete(key);
    }
  },
};

export default secretStore;
