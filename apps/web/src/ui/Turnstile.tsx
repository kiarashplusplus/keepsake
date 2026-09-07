/**
 * Native stub. Metro's platform resolution picks `Turnstile.web.tsx` over
 * this file when bundling for web; this milestone is web-only. Native
 * support needs a real Turnstile SDK/webview integration, so until then this
 * never reports a status at all — callers should keep any submit button
 * disabled when running on native, since `status` here starts at `pending`
 * and simply never advances.
 */
import * as React from "react";

export type TurnstileStatus =
  | { status: "unconfigured" }
  | { status: "pending" }
  | { status: "ready"; token: string }
  | { status: "expired" }
  | { status: "error"; reason: "script" | "widget" };

export type TurnstileHandle = {
  /** Forces the widget to fetch a fresh token. No-op on native (there is no
   * widget to reset). */
  reset: () => void;
};

export type TurnstileProps = {
  onStatus: (status: TurnstileStatus) => void;
};

export const Turnstile = React.forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile(_props, ref) {
  React.useImperativeHandle(ref, () => ({ reset: () => {} }), []);
  return null;
});
