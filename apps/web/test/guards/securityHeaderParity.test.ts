/**
 * The security headers are written down twice — `apps/web/public/_headers`'s
 * `/*` rule and `apps/api/src/middleware/securityHeaders.ts` — because they
 * are consumed by unrelated runtimes with no common module to share a
 * constant. Two hand-maintained copies of a security policy is the failure
 * mode this repo keeps hitting (#276, #284), and until now only *parts* of
 * the pair were held together: preflight's `csp-script-hash` compares the
 * `'sha256-'` values the two policies declare, and
 * `analyticsCsp.test.ts`/`reverseGeocodeCsp.test.ts` compare `connect-src`.
 * Nothing compared `Strict-Transport-Security`, `X-Frame-Options`,
 * `Referrer-Policy` or `X-Content-Type-Options` at all — deleting the HSTS
 * line from `_headers` was a green diff.
 *
 * That line is load-bearing on production specifically, which is why it is
 * worth a guard rather than a comment (#251). Issue #251 asserts that
 * "production's `run_worker_first` is a literal path list, so hashed
 * `/_expo/static/*` asset responses are answered by Cloudflare's assets
 * system without the Worker running, and those responses carry no HSTS
 * header". The first half is true — `[env.production.assets]` in
 * `apps/api/wrangler.toml` sets `run_worker_first` to a literal path list
 * rather than `true`, and that list names nothing under `/_expo/`, so the
 * Worker genuinely never runs for one. The second half is not: `_headers`
 * already carries the
 * whole security block under `/*`, and the assets system applies *every*
 * matching rule rather than only the most specific one, so the
 * `/_expo/static/*` `Cache-Control` rule does not shadow it.
 *
 * Measured rather than reasoned, 2026-09-09: a `wrangler dev` over a real
 * `apps/web/dist` with production's exact `run_worker_first` list and a
 * Worker that stamps `x-worker-ran` on everything it answers. A GET of
 * `/_expo/static/js/web/entry-<hash>.js` came back `200` with no
 * `x-worker-ran` (so the Worker never ran) and with
 * `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
 * alongside `Cache-Control: public, max-age=31536000, immutable`. Same for
 * `/fonts/*`, a `404` falling through to the SPA shell, a `405`, and the
 * assets system's own `307`.
 *
 * So `_headers` is the only thing standing between production's hashed asset
 * responses and no security headers at all, and this file is what makes
 * editing one copy and not the other go red.
 *
 * The parsers are deliberately literal — they read the two files as text
 * rather than importing anything — because the point is to compare what each
 * runtime will actually be handed, and neither runtime imports the other.
 */
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HEADERS_FILE = path.join(REPO_ROOT, "apps/web/public/_headers");
const MIDDLEWARE_FILE = path.join(REPO_ROOT, "apps/api/src/middleware/securityHeaders.ts");

/**
 * The headers under `_headers`' `/*` rule, in file order.
 *
 * A rule is a path line (starts with `/` or a scheme) followed by indented
 * `Name: value` lines; the block ends at the next path line. Comments (`#`)
 * and blank lines are skipped, which matters here because this file
 * documents each directive in a long comment block directly above the policy
 * — a whole-file scan would "find" headers the rule does not declare.
 */
export function headersUnderCatchAllRule(raw: string): Map<string, string> {
  const found = new Map<string, string>();
  let inCatchAll = false;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      inCatchAll = line === "/*";
      continue;
    }
    if (!inCatchAll) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    found.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return found;
}

/**
 * The headers `securityHeaders()` sets, in source order.
 *
 * `c.header("Name", "literal")` for the four simple ones;
 * `c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY)` names a
 * `["directive", ...].join("; ")` array instead, so that one is
 * reconstructed. Same array parser as `analyticsCsp.test.ts` — see that
 * file's note on why the two copies are read as text rather than imported.
 */
export function headersSetByMiddleware(raw: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of raw.matchAll(/c\.header\(\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    found.set(match[1] as string, match[2] as string);
  }
  for (const match of raw.matchAll(/c\.header\(\s*"([^"]+)"\s*,\s*([A-Z_][A-Z0-9_]*)\s*\)/g)) {
    const [, name, constant] = match as unknown as [string, string, string];
    found.set(name, joinedStringArray(raw, constant));
  }
  return found;
}

/** The value of `const <name> = ["a", "b"].join("; ")`, comments stripped. */
function joinedStringArray(raw: string, name: string): string {
  const start = raw.indexOf(`const ${name} = [`);
  const end = raw.indexOf('].join("; ")', start);
  if (start === -1 || end === -1) {
    throw new Error(`No \`const ${name} = [...].join("; ")\` in ${MIDDLEWARE_FILE}`);
  }
  const body = raw.slice(raw.indexOf("[", start) + 1, end);
  const directives: string[] = [];
  for (const entry of body.split(",\n")) {
    const withoutComments = entry
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .trim();
    if (withoutComments.length === 0) continue;
    const parts = withoutComments.match(/"((?:[^"\\]|\\.)*)"/g);
    if (parts === null) continue;
    directives.push(parts.map((p) => p.slice(1, -1)).join(""));
  }
  return directives.join("; ");
}

const fromHeadersFile = headersUnderCatchAllRule(fs.readFileSync(HEADERS_FILE, "utf8"));
const fromMiddleware = headersSetByMiddleware(fs.readFileSync(MIDDLEWARE_FILE, "utf8"));

/** Present in both copies today; each is here for a reason, so name them. */
const REQUIRED = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Frame-Options",
  "Referrer-Policy",
  "X-Content-Type-Options",
] as const;

describe("the two copies of the security headers agree", () => {
  it("both parsers found a policy at all", () => {
    // Guards the guard. A rename of the `/*` rule, of `c.header`, or of
    // `CONTENT_SECURITY_POLICY` would otherwise make every assertion below
    // compare two empty maps and pass forever — which is the shape of half
    // the rows in AGENTS.md's table.
    expect([...fromHeadersFile.keys()].length).toBeGreaterThanOrEqual(REQUIRED.length);
    expect([...fromMiddleware.keys()].length).toBeGreaterThanOrEqual(REQUIRED.length);
  });

  it.each(REQUIRED)("%s is declared in both", (name) => {
    expect(fromHeadersFile.get(name)).toBeDefined();
    expect(fromMiddleware.get(name)).toBeDefined();
  });

  it.each(REQUIRED)("%s has the same value in both", (name) => {
    expect(fromHeadersFile.get(name)).toBe(fromMiddleware.get(name));
  });

  it("neither copy sets a header the other does not", () => {
    // A new header added to one file and not the other is the same bug as a
    // changed value, one direction over.
    expect([...fromHeadersFile.keys()].sort()).toEqual([...fromMiddleware.keys()].sort());
  });

  it("HSTS is the value production's hashed assets depend on", () => {
    // `apps/web/public/_headers` is the only thing that sets this on a
    // `/_expo/static/*` response, because production's `run_worker_first`
    // list routes those around the Worker (#251, and the file's own comment).
    // Written out rather than only compared to the other copy: editing both
    // in step is still a change to what every browser is told to remember for
    // two years, and it should not be possible to do that silently.
    const hsts = "max-age=63072000; includeSubDomains; preload";
    expect(fromHeadersFile.get("Strict-Transport-Security")).toBe(hsts);
    expect(fromMiddleware.get("Strict-Transport-Security")).toBe(hsts);
  });
});
