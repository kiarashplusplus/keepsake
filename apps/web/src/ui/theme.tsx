// Theme provider + hooks. Ported from finderly-monorepo
// `frontend/src/design-system/theme.tsx`: light/dark/system mode, persisted
// preference, and — on the web — a palette that does not depend on which
// theme is in force at all.
//
// ## This provider used to render nothing until it had read localStorage
//
// It returned `null` while `hydrated` was false, so that the tree could not
// paint in the wrong palette before the stored preference arrived. On the
// web that was the single most expensive line in the app: `expo export`
// static-renders every route at build time, effects do not run there, so
// `hydrated` was false for the whole render and **every exported page
// shipped an empty `<body>`** — `<div id="root">` with a Suspense comment
// inside it and nothing else, on a product whose landing page is a feed of
// other people's things. Nothing was visible until the JS bundle had
// downloaded, parsed and hydrated, and any crawler or unfurler that does not
// run JavaScript saw an empty document. (`app/+html.tsx`'s own comment
// recorded the symptom — "expo export's per-route HTML ships an EMPTY body"
// — as a fact about Expo. It was this gate.)
//
// It is gone, and nothing takes its place, because the flash it was
// protecting against cannot happen any more: on the web the palette is
// `colorsWeb`, whose eight theme-dependent tokens are CSS custom properties
// resolved by the `data-theme` attribute the pre-hydration script in
// `app/+html.tsx` sets before the first paint. Server markup and client
// markup are byte-identical in both themes, so there is nothing to gate and
// nothing to mismatch. See `@keepsake/tokens/colors`' `colorsWeb`.
//
// `hydrated` still exists, and still means "the stored preference has been
// read". It gates exactly one thing now: writing `data-theme` back to the
// document. Until the read lands, `selectedMode` is "system" — which is what
// the static render assumed too, so the theme control's own markup matches —
// and `data-theme` is left exactly as the pre-hydration script set it from
// that same localStorage key. Overwriting it from an unread preference is
// the one way this could still flash.
import * as React from "react";
import { Platform, useColorScheme as useRNColorScheme } from "react-native";
import { colorsFor, colorsWeb, type ColorMode, type ColorTokens } from "@keepsake/tokens/colors";
import { prefStore } from "@/lib/prefStore";

export type ThemeMode = "light" | "dark" | "system";

const THEME_MODE_STORAGE_KEY = "keepsake.theme.v1";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function applyDomTheme(effective: ColorMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = effective;
  document.documentElement.style.colorScheme = effective;
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  // A REAL colour, not the `var(--ks-bg)` the tree renders with: this value
  // is read by the browser to paint its own chrome, outside any stylesheet,
  // where a custom property means nothing.
  meta.setAttribute("content", colorsFor(effective).bg);
}

type ThemeContextValue = {
  colors: ColorTokens;
  /** Effective mode after resolving "system" to the OS/browser scheme. */
  mode: ColorMode;
  /** User-selected preference (can be "system") for UI controls. */
  selectedMode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({
  mode,
  children,
}: {
  mode?: ThemeMode;
  children: React.ReactNode;
}): React.ReactElement | null {
  const persistsPreference = mode === undefined;
  const osScheme = useRNColorScheme();
  const [explicitMode, setExplicitMode] = React.useState<ThemeMode>(mode ?? "system");
  const [hydrated, setHydrated] = React.useState(!persistsPreference);

  // `hydrated` starts true when a mode is forced (nothing to read) and false
  // when the preference is persisted; only the async read flips it, so no
  // state is written synchronously inside the effect.
  React.useEffect(() => {
    if (!persistsPreference) return;
    let cancelled = false;
    void prefStore.getItem(THEME_MODE_STORAGE_KEY).then((storedMode) => {
      if (cancelled) return;
      if (isThemeMode(storedMode)) setExplicitMode(storedMode);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [persistsPreference]);

  const setMode = React.useCallback(
    (nextMode: ThemeMode) => {
      setExplicitMode(nextMode);
      if (persistsPreference) {
        void prefStore.setItem(THEME_MODE_STORAGE_KEY, nextMode);
      }
    },
    [persistsPreference],
  );

  // A forced `mode` prop wins over the persisted choice without an effect.
  const chosenMode: ThemeMode = mode ?? explicitMode;
  const effective: ColorMode = chosenMode === "system" ? (osScheme === "dark" ? "dark" : "light") : chosenMode;

  // On the web this is the SAME object in both modes — the eight tokens that
  // flip are `var(--ks-…)` references, so nothing in the tree re-renders on a
  // theme change and nothing depends on which theme rendered it. Native has
  // no CSS and no server render, so it keeps the resolved palette.
  const colors = Platform.OS === "web" ? colorsWeb : colorsFor(effective);

  React.useEffect(() => {
    if (!hydrated) return;
    applyDomTheme(effective);
  }, [effective, hydrated]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ colors, mode: effective, selectedMode: chosenMode, setMode }),
    [colors, effective, chosenMode, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const FALLBACK_CONTEXT: ThemeContextValue = {
  colors: Platform.OS === "web" ? colorsWeb : colorsFor("light"),
  mode: "light",
  selectedMode: "system",
  setMode: () => {},
};

export function useColors(): ColorTokens {
  const ctx = React.useContext(ThemeContext);
  return ctx?.colors ?? FALLBACK_CONTEXT.colors;
}

export function useThemeMode(): ThemeContextValue {
  return React.useContext(ThemeContext) ?? FALLBACK_CONTEXT;
}

/**
 * The lined-index-card rule: a single 2px baseline under a field, in `ink`
 * — never a full hairline box. The v3 identity draws a form field as a
 * ruled card, not a bordered rectangle.
 */
export function useContainerBorder(): { borderBottomWidth: number; borderBottomColor: string } {
  const colors = useColors();
  return { borderBottomWidth: 2, borderBottomColor: colors.ink };
}
