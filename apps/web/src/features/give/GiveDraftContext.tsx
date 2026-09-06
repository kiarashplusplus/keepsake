import * as React from "react";
import {
  GIVE_DRAFT_INITIAL,
  GIVE_DRAFT_STORAGE_KEY,
  deserializeGiveDraft,
  giveDraftReducer,
  serializeGiveDraft,
  type GiveDraft,
  type GiveDraftAction,
} from "@/features/give/giveDraft";

function hasSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function readInitialDraft(): GiveDraft {
  if (!hasSessionStorage()) return GIVE_DRAFT_INITIAL;
  try {
    const raw = window.sessionStorage.getItem(GIVE_DRAFT_STORAGE_KEY);
    if (raw === null) return GIVE_DRAFT_INITIAL;
    return deserializeGiveDraft(raw) ?? GIVE_DRAFT_INITIAL;
  } catch {
    return GIVE_DRAFT_INITIAL;
  }
}

type GiveDraftContextValue = {
  draft: GiveDraft;
  dispatch: React.Dispatch<GiveDraftAction>;
};

const GiveDraftContext = React.createContext<GiveDraftContextValue | undefined>(undefined);

/** Persists the whole draft to `sessionStorage` on every change. `sessionStorage`
 * is synchronous and web-only, so — unlike `ThemeProvider`'s `prefStore`
 * hydration gate — this reads its initial value straight from the reducer's
 * lazy initializer instead of rendering `null` for a frame. */
export function GiveDraftProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [draft, dispatch] = React.useReducer(giveDraftReducer, undefined, readInitialDraft);

  React.useEffect(() => {
    if (!hasSessionStorage()) return;
    try {
      window.sessionStorage.setItem(GIVE_DRAFT_STORAGE_KEY, serializeGiveDraft(draft));
    } catch {
      // Best-effort: a full sessionStorage quota shouldn't break the give flow.
    }
  }, [draft]);

  const value = React.useMemo<GiveDraftContextValue>(() => ({ draft, dispatch }), [draft]);

  return <GiveDraftContext.Provider value={value}>{children}</GiveDraftContext.Provider>;
}

export function useGiveDraft(): GiveDraftContextValue {
  const ctx = React.useContext(GiveDraftContext);
  if (!ctx) throw new Error("useGiveDraft must be used within a GiveDraftProvider");
  return ctx;
}
