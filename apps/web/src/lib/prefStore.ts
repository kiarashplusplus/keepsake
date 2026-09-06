/**
 * Tiny async key/value wrapper around `localStorage`, for non-secret user
 * preferences (theme mode, location/radius, etc). Ported from
 * finderly-monorepo `frontend/src/utils/prefStore.ts`, web-only slice: this
 * package is web-only for M0 (native lands later behind
 * `prefStore.native.ts`).
 *
 * Guarded for SSR / static export: `expo export --platform web` and any
 * server-side render pass evaluate modules where `window` does not exist,
 * so every call falls back to an in-memory Map rather than throwing.
 */
type PrefStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

const memory = new Map<string, string>();

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export const prefStore: PrefStore = {
  async getItem(key) {
    try {
      if (!hasWindow()) return memory.get(key) ?? null;
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  async setItem(key, value) {
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
  async removeItem(key) {
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

export default prefStore;
