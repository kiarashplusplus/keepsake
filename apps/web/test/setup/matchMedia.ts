/**
 * jsdom (the environment jest-expo/web's preset uses) doesn't implement
 * `window.matchMedia` — most of this app guards every call with
 * `typeof window.matchMedia === "function"` (see `MotionProvider.tsx`), but
 * `react-native-reanimated`'s own `ReducedMotion` module calls it
 * unconditionally at import time, so anything that pulls in `Seal` or
 * `Skeleton` (both animated with reanimated) crashes on `require` before a
 * single test even runs. A minimal stub is enough — nothing here asserts on
 * media-query behavior itself.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

export {};
