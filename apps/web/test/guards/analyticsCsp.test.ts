/**
 * Every consent-gated tag reports to somewhere, and `connect-src` has to name
 * it or the tag loads and is then refused when it tries to say anything.
 *
 * This is the sibling of `reverseGeocodeCsp.test.ts` and exists for a failure
 * that actually shipped. `script-src` had permitted
 * `https://static.cloudflareinsights.com` for as long as the banner has
 * existed, so the Cloudflare Web Analytics beacon *loaded* — but its data goes
 * to `https://cloudflareinsights.com/cdn-cgi/rum`, a different origin (note the
 * missing `static.`), and `connect-src` did not list it. The moment
 * `EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN` was configured, the product had a
 * working banner, a working opt-in, a beacon that fetched with HTTP 200, and
 * no analytics at all.
 *
 * Nothing in the suite could have caught it. `test/lib/consent.test.ts` mocks
 * the DOM, a mocked script tag has no network, and a fetch that a browser
 * refuses on CSP grounds is indistinguishable in jsdom from one that succeeds.
 * The only witness was `Connecting to 'https://cloudflareinsights.com/cdn-cgi/rum'
 * violates the following Content Security Policy directive` in the console of
 * a real browser pointed at a real deployment.
 *
 * So the origin is declared once, on the provider in `public/consent.js` that
 * loads the tag, and this holds both copies of the CSP to it. Proven rather
 * than assumed: removing `https://cloudflareinsights.com` from either
 * `_headers` or `securityHeaders.ts` fails this file for that copy, and
 * removing the `beacon` key from `consent.js` fails it for both.
 *
 * A provider with no `beacon` is skipped on purpose. Google Ads has none
 * because it is not configured in any environment (`ks-google-ads-id` is
 * served empty) and its reporting origins are deliberately not in the CSP;
 * whoever turns it on adds `beacon` there and this file starts requiring the
 * origins here, which is the point.
 */
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HEADERS_FILE = path.join(REPO_ROOT, "apps/web/public/_headers");
const MIDDLEWARE_FILE = path.join(REPO_ROOT, "apps/api/src/middleware/securityHeaders.ts");
const CONSENT_FILE = path.join(REPO_ROOT, "apps/web/public/consent.js");

/** The `_headers` copy: one literal line under the `/*` rule. */
function cspFromHeadersFile(): string {
  const raw = fs.readFileSync(HEADERS_FILE, "utf8");
  const line = raw.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  if (line === undefined) throw new Error(`No Content-Security-Policy line in ${HEADERS_FILE}`);
  return line.slice(line.indexOf(":") + 1).trim();
}

/** The Worker copy: a `["directive", ...].join("; ")` array, so it is
 * reconstructed rather than read as one literal. Same parser as
 * `reverseGeocodeCsp.test.ts`; see that file's note on why. */
function cspFromMiddleware(): string {
  const raw = fs.readFileSync(MIDDLEWARE_FILE, "utf8");
  const start = raw.indexOf("const CONTENT_SECURITY_POLICY = [");
  const end = raw.indexOf('].join("; ")', start);
  if (start === -1 || end === -1) throw new Error(`No CONTENT_SECURITY_POLICY array in ${MIDDLEWARE_FILE}`);
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

function connectSrc(csp: string): string {
  const directive = csp.split(";").find((d) => d.trim().startsWith("connect-src "));
  if (directive === undefined) {
    throw new Error(
      `CSP has no connect-src directive — it falls back to default-src, which blocks every cross-origin request:\n${csp}`,
    );
  }
  return directive.trim();
}

/**
 * `consent.js` is browser-global script rather than a module, so its
 * `PROVIDERS` cannot be imported. Reading the `beacon:` values out of the
 * source keeps one declaration rather than a second copy here that could
 * agree with the CSP while both disagreed with the app.
 */
function declaredBeaconOrigins(): string[] {
  const raw = fs.readFileSync(CONSENT_FILE, "utf8");
  const start = raw.indexOf("const PROVIDERS = [");
  if (start === -1) throw new Error(`No PROVIDERS array in ${CONSENT_FILE}`);
  const body = raw.slice(start, raw.indexOf("];", start));
  return Array.from(body.matchAll(/beacon:\s*'([^']+)'/g)).map((m) => m[1] as string);
}

describe("analytics beacon origins are in connect-src", () => {
  const origins = declaredBeaconOrigins();

  it("consent.js declares at least one beacon origin", () => {
    // Guards the guard: a rename of `beacon` would otherwise make every
    // assertion below vacuous and this file would pass while the CSP rotted.
    expect(origins.length).toBeGreaterThan(0);
    expect(origins).toContain("https://cloudflareinsights.com");
  });

  it.each([
    ["apps/web/public/_headers", cspFromHeadersFile],
    ["apps/api/src/middleware/securityHeaders.ts", cspFromMiddleware],
  ])("%s permits every declared beacon origin", (_label, read) => {
    const directive = connectSrc(read());
    for (const origin of origins) {
      expect(directive).toContain(origin);
    }
  });

  it("the two copies of connect-src agree", () => {
    expect(connectSrc(cspFromHeadersFile())).toBe(connectSrc(cspFromMiddleware()));
  });

  it("the reporting origin is not confused with the script origin", () => {
    // `static.cloudflareinsights.com` in connect-src instead of
    // `cloudflareinsights.com` is the exact mistake that would look correct in
    // review and still block every beacon.
    expect(origins).not.toContain("https://static.cloudflareinsights.com");
  });
});
