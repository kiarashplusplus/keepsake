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
/**
 * **Do not add `image/heic` here.** iOS Safari transcodes a HEIC library
 * photo to JPEG on the way out of a file input precisely *because* HEIC is
 * absent from `accept` — widening this would hand us the raw HEIC on the one
 * platform where the problem is otherwise solved for us. Browsers that ignore
 * `accept` (and desktop pickers where the user chooses "All files") are
 * handled the other way round, by `validateImage.ts` deferring to the decode
 * and `prepareUpload.ts` giving a HEIC that failed to decode its own message.
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
      input.removeEventListener("cancel", onCancel);
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

    // Every current engine fires `cancel` on the input when the dialog is
    // dismissed, which is the unambiguous signal.
    const onCancel = (): void => {
      settle([]);
    };

    // Fallback for engines that don't fire `cancel`. This is a genuine race,
    // not just redundancy: on a slow `change` dispatch the timer can settle a
    // real pick as a cancel, which is why `cancel` above is preferred and the
    // delay here is generous rather than tight.
    const onWindowFocus = (): void => {
      window.setTimeout(() => {
        if (!settled) settle([]);
      }, 300);
    };

    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    window.addEventListener("focus", onWindowFocus, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}
