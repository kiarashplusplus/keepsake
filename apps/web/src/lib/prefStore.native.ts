/**
 * Native stub. Metro's platform resolution picks this file over
 * `prefStore.ts` when bundling for iOS/Android; this milestone is web-only
 * (see app.base.json — no ios/android config yet), so native support lands
 * with the native flip and should use expo-secure-store's AsyncStorage
 * sibling, not this throw.
 */
export const prefStore = {
  async getItem(_key: string): Promise<string | null> {
    throw new Error("prefStore: native not implemented yet (web-only milestone)");
  },
  async setItem(_key: string, _value: string): Promise<void> {
    throw new Error("prefStore: native not implemented yet (web-only milestone)");
  },
  async removeItem(_key: string): Promise<void> {
    throw new Error("prefStore: native not implemented yet (web-only milestone)");
  },
};

export default prefStore;
