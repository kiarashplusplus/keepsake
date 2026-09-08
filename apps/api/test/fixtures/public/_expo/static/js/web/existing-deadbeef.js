// Test-only stand-in for a real route chunk under `_expo/static/js/web/*`
// (apps/web's export names these `<route>-<contenthash>.js`, e.g.
// `give-3f9a...js`). Proves a chunk that genuinely exists still serves as
// itself and is not caught by the 404 rewrite in `src/index.ts` (#272),
// which only applies when the assets binding falls through to the SPA
// shell (i.e. answers `text/html`) for a path under this prefix.
console.log("existing chunk");
