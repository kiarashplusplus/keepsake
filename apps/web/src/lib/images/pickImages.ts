/**
 * Native stub. Metro's platform resolution picks `pickImages.web.ts` over
 * this file when bundling for web; this milestone is web-only (see
 * app.base.json). Native support should use `expo-image-picker`, not a
 * hidden `<input>`, when the native flip happens.
 */
export function pickImages(_options: { multiple?: boolean } = {}): Promise<File[]> {
  throw new Error("pickImages: native not implemented yet (web-only milestone)");
}
