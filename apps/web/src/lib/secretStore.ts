/**
 * Native stub. Metro's platform resolution picks `secretStore.web.ts` over
 * this file when bundling for web; this milestone is web-only (see
 * app.base.json — no ios/android config yet). Native support should back
 * this with `expo-secure-store`, not `localStorage`, when the native flip
 * happens — see `prefStore.native.ts` for the same pattern.
 */
export const secretStore = {
  getItem(_key: string): string | null {
    throw new Error("secretStore: native not implemented yet (web-only milestone)");
  },
  setItem(_key: string, _value: string): void {
    throw new Error("secretStore: native not implemented yet (web-only milestone)");
  },
  removeItem(_key: string): void {
    throw new Error("secretStore: native not implemented yet (web-only milestone)");
  },
};

export default secretStore;
