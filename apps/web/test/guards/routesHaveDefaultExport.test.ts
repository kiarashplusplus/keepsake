/**
 * Guard: every route file under `app/` exports a default component.
 * expo-router treats each file's default export as the screen; a route file
 * that exports something else (or nothing) renders a blank screen with no
 * build-time error — Metro compiles it fine, expo-router just has nothing
 * to mount. `_layout.tsx` and `+html.tsx` are special (not screens in the
 * usual sense) but still require a default export per expo-router's own
 * contract, so they're included rather than excluded.
 */
import fs from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(__dirname, "..", "..", "app");
const ROUTE_EXTENSIONS = new Set([".ts", ".tsx"]);

function collectRouteFiles(absRoot: string, out: string[]): void {
  for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const abs = path.join(absRoot, entry.name);
    if (entry.isDirectory()) {
      collectRouteFiles(abs, out);
      continue;
    }
    if (!ROUTE_EXTENSIONS.has(path.extname(entry.name))) continue;
    // .d.ts and test files are never routes.
    if (entry.name.endsWith(".d.ts") || entry.name.includes(".test.")) continue;
    out.push(abs);
  }
}

describe("app/ routes have a default export", () => {
  const files: string[] = [];
  collectRouteFiles(APP_DIR, files);

  it("finds a non-empty set of route files (positive control)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(APP_DIR, f), f] as const))("%s exports a default", (_rel, absPath) => {
    const source = fs.readFileSync(absPath, "utf8");
    const hasDefaultExport = /export\s+default\b/.test(source);
    expect(hasDefaultExport).toBe(true);
  });
});
