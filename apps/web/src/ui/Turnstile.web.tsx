/**
 * Cloudflare Turnstile, explicit-render API. `EXPO_PUBLIC_TURNSTILE_SITE_KEY`
 * is empty until the widget is provisioned for the domain — in that case
 * this reports `{status:"unconfigured"}` immediately, so the give flow (and
 * any other Turnstile-protected submit) still works end to end on preview
 * before the real widget exists (the API's own server-side `siteverify`
 * call is likewise skipped when no secret is configured).
 *
 * `status` is an explicit union rather than a token-or-`""` sentinel so a
 * caller can tell "not configured" (submit allowed) apart from "still
 * loading" (submit must wait) — see the give-flow plan's Turnstile section
 * for why the old `""` sentinel couldn't do that.
 *
 * There is deliberately no "genuinely broken" arm. Every way this widget can
 * fail — the script blocked by an ad blocker, `turnstile.render()` finding no
 * container, or Cloudflare firing `error-callback` (110200 "unknown domain"
 * on a hostname outside the widget's allowlist, or an ordinary 600xxx blip) —
 * reports `unconfigured`, which means "submit is allowed; the server decides".
 * The API's own `siteverify` call is the real gate and it fails closed there,
 * where it belongs. A client that blocks on a challenge it has no way to retry
 * buys no security and costs a completed listing: it left every submit button
 * in the app permanently disabled, with no message and no retry (issue #174).
 */
import * as React from "react";
import { View } from "react-native";
import { config } from "@/lib/config";
import { useThemeMode } from "@/ui/theme";

export type TurnstileStatus =
  | { status: "unconfigured" }
  | { status: "pending" }
  | { status: "ready"; token: string }
  | { status: "expired" };

export type TurnstileHandle = {
  /** Forces the widget to fetch a fresh token — used after a `turnstile_failed`
   * response, so a retry gets a new challenge instead of resubmitting the
   * same (already-rejected) one. */
  reset: () => void;
};

export type TurnstileProps = {
  onStatus: (status: TurnstileStatus) => void;
};

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
// Set on the `<script>` element once its `load`/`error` event has actually
// fired, so a *second* mount that finds this same tag already in the DOM
// (rather than `scriptPromise` — see below) can tell "already finished,
// resolve immediately" apart from "still in flight, attach a listener"
// instead of attaching a `load` listener to an event that already happened
// and will never fire again.
const LOAD_STATE_ATTR = "data-ks-turnstile-load-state";

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      const state = existing.getAttribute(LOAD_STATE_ATTR);
      if (state === "loaded") {
        resolve();
        return;
      }
      if (state !== "error") {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("Failed to load the Turnstile script")));
        return;
      }
      // A tag that already errored won't retry itself just because we ask
      // again — remove it so this attempt (paired with `scriptPromise`
      // having been cleared on the earlier rejection, below) is a *real*
      // retry, with a fresh `<script>`, not a replay of the same failure.
      existing.remove();
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      script.setAttribute(LOAD_STATE_ATTR, "loaded");
      resolve();
    };
    script.onerror = () => {
      script.setAttribute(LOAD_STATE_ATTR, "error");
      reject(new Error("Failed to load the Turnstile script"));
    };
    document.head.appendChild(script);
  });

  // Cache the promise so concurrent/later mounts share one script load —
  // but only while it can still resolve. A failed load must NOT poison
  // every later mount for the life of the tab: clear the cache on
  // rejection so the next caller gets a fresh attempt (e.g. a retry after
  // the giver disables their ad blocker).
  scriptPromise = promise.catch((err: unknown) => {
    scriptPromise = null;
    throw err;
  });
  return scriptPromise;
}

export const Turnstile = React.forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile({ onStatus }, ref) {
  const { mode } = useThemeMode();
  const containerRef = React.useRef<View>(null);
  const widgetIdRef = React.useRef<string | null>(null);
  const onStatusRef = React.useRef(onStatus);
  React.useEffect(() => {
    onStatusRef.current = onStatus;
  });

  // Read once: the widget's own theme is fixed at render time by
  // Cloudflare's API, and re-running this whole effect on every theme
  // toggle used to remount the widget and discard whatever token the
  // giver already had — see the file's `useEffect` deps below.
  const initialModeRef = React.useRef(mode);

  React.useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
      },
    }),
    [],
  );

  React.useEffect(() => {
    if (!config.turnstileSiteKey) {
      onStatusRef.current({ status: "unconfigured" });
      return undefined;
    }

    let cancelled = false;
    // Whether the widget has handed us a token that has not expired. A late
    // `error-callback` — a failed *refresh* after a good challenge — must not
    // throw away a token the giver can still spend; `expired-callback` is the
    // one thing that retires one.
    let hasLiveToken = false;
    onStatusRef.current({ status: "pending" });

    loadTurnstileScript()
      .then(() => {
        if (cancelled) return;
        const node = containerRef.current as unknown as HTMLElement | null;
        if (!node || !window.turnstile) {
          // The script loaded but there is nothing to render into. Same
          // answer as a blocked script: let the server decide (see the file
          // header) rather than disabling submit with nothing to say.
          onStatusRef.current({ status: "unconfigured" });
          return;
        }
        widgetIdRef.current = window.turnstile.render(node, {
          sitekey: config.turnstileSiteKey,
          theme: initialModeRef.current,
          callback: (token: string) => {
            hasLiveToken = true;
            onStatusRef.current({ status: "ready", token });
          },
          "expired-callback": () => {
            // Turnstile tokens expire after 300s; reset re-issues a fresh
            // one, but the *current* token is no longer good — callers must
            // not go on treating `ready` as still true.
            hasLiveToken = false;
            onStatusRef.current({ status: "expired" });
            if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
          },
          "error-callback": () => {
            // The challenge itself failed after the script loaded fine —
            // 110200 on a hostname outside the widget's allowlist (the
            // preview Worker's `workers.dev` names, #105), or a transient
            // 600xxx. Reporting `error` here is what left the giver looking
            // at a greyed-out "Give it" with a filled-in form, no copy and no
            // retry (#174). No `reset()` from here: on a permanent failure
            // like 110200 the reset re-errors immediately, which is an
            // unbounded retry loop against Cloudflare. A retry still happens
            // where it can succeed — each consumer resets the widget when the
            // API answers `turnstile_failed`.
            if (hasLiveToken) return;
            onStatusRef.current({ status: "unconfigured" });
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        // The script itself failed to load outright — an ad blocker, a
        // blocked CDN, offline. There's no way to prove humanity client-side
        // in that case, but that's no reason to dead-end someone behind a
        // blocker: report `unconfigured` (submit allowed) and let the
        // server's own `siteverify` call decide, the same as it already
        // does when no site key is configured at all.
        onStatusRef.current({ status: "unconfigured" });
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
    // Empty on purpose: `mode` is read once into `initialModeRef` above
    // (not referenced directly here), so a theme toggle no longer remounts
    // the widget and discards whatever token the giver already has.
  }, []);

  if (!config.turnstileSiteKey) return <View />;

  return <View ref={containerRef} accessibilityLabel="Verification widget" />;
});
