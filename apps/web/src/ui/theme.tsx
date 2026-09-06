// Theme provider + hooks. Ported from finderly-monorepo
// `frontend/src/design-system/theme.tsx`: light/dark/system mode, persisted
// preference, hydration-gated so there is no flash of the wrong theme
// before the stored value is read (the `app/+html.tsx` pre-hydration script
// handles the *pre-JS* flash by setting `data-theme` synchronously; this
// provider handles the *post-hydration* React-tree render).
import * as React from "react";
import { StyleSheet, useColorScheme as useRNColorScheme } from "react-native";
import { colorsFor, type ColorMode, type ColorTokens } from "@keepsake/tokens/colors";
import { prefStore } from "@/lib/prefStore";

export type ThemeMode = "light" | "dark" | "system";

const THEME_MODE_STORAGE_KEY = "keepsake.theme.v1";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function applyDomTheme(effective: ColorMode, colors: ColorTokens): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = effective;
  document.documentElement.style.colorScheme = effective;
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", colors.bg);
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

  const colors = colorsFor(effective);

  React.useEffect(() => {
    if (!hydrated) return;
    applyDomTheme(effective, colors);
  }, [effective, colors, hydrated]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ colors, mode: effective, selectedMode: chosenMode, setMode }),
    [colors, effective, chosenMode, setMode],
  );

  if (!hydrated) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const FALLBACK_CONTEXT: ThemeContextValue = {
  colors: colorsFor("light"),
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
 * The canonical hairline border for elevated containers (cards, sheets,
 * inputs) so every surface reads as the same layer. 1 device pixel thin.
 */
export function useContainerBorder(): { borderWidth: number; borderColor: string } {
  const colors = useColors();
  return { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border };
}
