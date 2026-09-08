// Wrangler compiles an imported `.wasm` file at deploy time and binds it as an
// already-instantiated `WebAssembly.Module`. This is the whole reason the card
// can rasterise inside a Worker at all: `WebAssembly.compile()` is disallowed
// at runtime there, so a library that fetches-and-compiles its own wasm cannot
// work, while one that accepts a pre-compiled `Module` — which
// `@resvg/resvg-wasm`'s `initWasm` does — can.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
