/**
 * Cloudflare Turnstile, explicit-render API. `EXPO_PUBLIC_TURNSTILE_SITE_KEY`
 * is empty until the widget is provisioned for the domain — in that case
 * this renders nothing and reports a token of `""` immediately, so the give
 * flow (and any other Turnstile-protected submit) still works end to end on
 * preview before the real widget exists (the API's own server-side
 * `siteverify` call is likewise skipped when no secret is configured).
 */
import * as React from "react";
import { View } from "react-native";
import { config } from "@/lib/config";
import { useThemeMode } from "@/ui/theme";

type TurnstileRenderOptions = {
  sitekey: string;
  theme: "light" | "dark";
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load the Turnstile script"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export type TurnstileProps = {
  onToken: (token: string) => void;
};

export function Turnstile({ onToken }: TurnstileProps): React.ReactElement {
  const { mode } = useThemeMode();
  const containerRef = React.useRef<View>(null);
  const widgetIdRef = React.useRef<string | null>(null);
  const onTokenRef = React.useRef(onToken);
  React.useEffect(() => {
    onTokenRef.current = onToken;
  });

  React.useEffect(() => {
    if (!config.turnstileSiteKey) {
      onTokenRef.current("");
      return undefined;
    }

    let cancelled = false;

    void loadTurnstileScript().then(() => {
      if (cancelled) return;
      const node = containerRef.current as unknown as HTMLElement | null;
      if (!node || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(node, {
        sitekey: config.turnstileSiteKey,
        theme: mode,
        callback: (token: string) => onTokenRef.current(token),
        "expired-callback": () => {
          // Turnstile tokens expire after 300s; reset re-issues a fresh one.
          if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
        },
        "error-callback": () => onTokenRef.current(""),
      });
    });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [mode]);

  if (!config.turnstileSiteKey) return <View />;

  return <View ref={containerRef} accessibilityLabel="Verification widget" />;
}
