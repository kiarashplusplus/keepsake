/**
 * Guard: no web module may import the bare barrel of a shared workspace
 * package. Adapted from finderly-monorepo
 * `frontend/test/guards/bundleBoundaries.test.ts` — that repo's bare
 * `@finderly/project-state` import pulled a server-only auth chain
 * (jsonwebtoken -> jws -> node:util) into the web bundle; Metro stubs node
 * core as an empty module on web, so `util.inherits` was undefined and the
 * whole SPA rendered a blank page for ~70 minutes while every HTTP-level
 * health check stayed green.
 *
 * Why a Jest test rather than only the ESLint rule (`eslint.config.mjs`'s
 * `no-restricted-imports`): that lint rule is real here (unlike finderly's
 * dead `.eslintrc.js` copy, which no CI workflow ran) but a second,
 * independent enforcement point is cheap insurance against a lint config
 * regression, and this file's positive-control test (below) proves the scan
 * itself isn't silently vacuous — the exact failure mode that let finderly's
 * ESLint version sit dead for months.
 *
 * This repo's packages (`@keepsake/tokens`, `@keepsake/contracts`,
 * `@keepsake/observability`) export subpaths ONLY — no `"."` entry — so a
 * bare import fails to resolve at build time too. Still worth guarding
 * explicitly: a resolution failure surfaces as a Metro build error, not a
 * readable "why this is banned" message, and only if someone actually tries
 * to build after adding the bad import.
 *
 * Validated by breaking it: added `import { colorsLight } from
 * "@keepsake/tokens";` to a scratch file, ran this suite, watched it fail
 * with the expected message, then removed the import (see the task report).
 */
import fs from "node:fs";
import path from "node:path";

const SCAN_ROOTS = ["app", "src"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const BANNED_BARRELS = [
  { specifier: "@keepsake/tokens", reason: "subpath exports only — import '@keepsake/tokens/colors', '/spacing', '/radii', '/typography' or '/motion' instead." },
  { specifier: "@keepsake/contracts", reason: "not used in this milestone; subpath exports only when it is." },
  { specifier: "@keepsake/observability", reason: "not used in this milestone; subpath exports only when it is." },
] as const;

function importPattern(specifier: string): RegExp {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`(?:from|require\(|import\()\s*['"]${escaped}['"]`);
}

function collectFiles(absRoot: string, out: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absRoot);
  } catch {
    return;
  }

  if (stat.isFile()) {
    if (SCAN_EXTENSIONS.has(path.extname(absRoot))) out.push(absRoot);
    return;
  }

  for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    collectFiles(path.join(absRoot, entry.name), out);
  }
}

describe("bundle boundaries", () => {
  const webRoot = path.resolve(__dirname, "..", "..");

  const files: string[] = [];
  for (const root of SCAN_ROOTS) collectFiles(path.join(webRoot, root), files);

  it("scans a non-empty set of web source files", () => {
    // Positive control: without this, a bad SCAN_ROOTS path would make every
    // assertion below vacuous.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(BANNED_BARRELS)("no web module imports the bare $specifier barrel", ({ specifier, reason }) => {
    const pattern = importPattern(specifier);
    const offenders: string[] = [];

    for (const file of files) {
      if (file === __filename) continue;
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes(specifier)) continue;
      source.split("\n").forEach((line, index) => {
        if (pattern.test(line)) {
          offenders.push(`${path.relative(webRoot, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `Bare barrel import of '${specifier}' is banned because ${reason}\n\nOffending imports:\n` +
          offenders.map((o) => `  ${o}`).join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("the ban regex matches bare imports but not subpath imports", () => {
    const pattern = importPattern("@keepsake/tokens");

    expect(pattern.test(`} from "@keepsake/tokens";`)).toBe(true);
    expect(pattern.test(`import x from '@keepsake/tokens'`)).toBe(true);
    expect(pattern.test(`const x = require("@keepsake/tokens")`)).toBe(true);
    expect(pattern.test(`await import('@keepsake/tokens')`)).toBe(true);

    expect(pattern.test(`} from "@keepsake/tokens/colors";`)).toBe(false);
    expect(pattern.test(`} from "@keepsake/tokens/typography";`)).toBe(false);
    expect(pattern.test(`} from "@keepsake/tokens-other";`)).toBe(false);
  });
});
