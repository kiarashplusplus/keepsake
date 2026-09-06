/**
 * Web-only file picker: a hidden `<input type="file">` created, clicked, and
 * torn down for a single pick. Uses `document.createElement` directly (the
 * same escape hatch `src/ui/theme.tsx`'s `applyDomTheme` already uses for
 * `<meta>`/`documentElement` on this web-only milestone) rather than
 * react-native-web's `createElement` helper, which returns a React element
 * for mounting inside the render tree rather than a standalone DOM node —
 * awkward for a one-shot imperative picker that isn't part of any
 * component's output.
 */
const ACCEPT = "image/jpeg,image/png,image/webp";

export function pickImages(options: { multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve([]);
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.multiple = options.multiple ?? true;
    input.style.position = "fixed";
    input.style.top = "-9999px";
    input.style.left = "-9999px";
    input.setAttribute("aria-hidden", "true");

    let settled = false;

    const cleanup = (): void => {
      input.removeEventListener("change", onChange);
      window.removeEventListener("focus", onWindowFocus);
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    const settle = (files: File[]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(files);
    };

    const onChange = (): void => {
      const files = input.files ? Array.from(input.files) : [];
      settle(files);
    };

    // The browser doesn't fire a reliable "cancel" event on every platform;
    // a window focus shortly after the dialog closes with no files selected
    // is the closest we get without a change event, so fall back to an
    // empty array in that case.
    const onWindowFocus = (): void => {
      window.setTimeout(() => {
        if (!settled) settle([]);
      }, 300);
    };

    input.addEventListener("change", onChange);
    window.addEventListener("focus", onWindowFocus, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}
