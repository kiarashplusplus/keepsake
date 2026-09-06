/**
 * Native stub. Metro's platform resolution picks `Turnstile.web.tsx` over
 * this file when bundling for web; this milestone is web-only. Native
 * support needs a real Turnstile SDK/webview integration, so until then this
 * never reports a token — callers should keep any submit button disabled
 * when running on native.
 */
export type TurnstileProps = {
  onToken: (token: string) => void;
};

export function Turnstile(_props: TurnstileProps): null {
  return null;
}
