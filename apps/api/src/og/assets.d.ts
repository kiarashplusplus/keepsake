// `[[rules]] type = "Data"` in `wrangler.toml` makes wrangler's bundler
// resolve a `.ttf` import to the file's bytes as an `ArrayBuffer`. TypeScript
// has no idea that rule exists — without this declaration every font import in
// `fonts.ts` is `TS2307: Cannot find module`.
//
// `ArrayBuffer` and not `Uint8Array`: that is what the Data loader actually
// hands back at runtime, and typing it as the view would make
// `new Uint8Array(buf)` in `fonts.ts` look redundant when it is required.
//
// The equivalent declaration for the wasm import lives in `resvg.d.ts`, next
// to the one module that needs it, rather than being merged here — they come
// from different bundler mechanisms (`type = "Data"` vs wrangler's built-in
// `.wasm` handling) and are worth being able to remove independently.
declare module "*.ttf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
