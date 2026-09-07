/**
 * Guard for issue #132: the Content Security Policy has to permit the
 * origins `src/lib/geoReverse.ts` actually calls, or "Use my location" is
 * dead on every deployed site.
 *
 * It shipped dead. Both policies declared `default-src 'self'` and no
 * `connect-src`; `connect-src` falls back to `default-src`, so the browser
 * dropped both reverse-geocode `fetch` calls before they left the page.
 * `reverseGeocode` cannot tell "blocked by CSP" from "provider down" — it
 * throws the same `MANUAL_ENTRY_MESSAGE` either way — so the give flow told
 * every giver to type their postcode in by hand and nothing anywhere logged
 * a fault.
 *
 * The reason no test caught it, and the reason this one is written the way
 * it is: `test/lib/geoReverse.test.ts` mocks `fetch`, and a mocked fetch is
 * never subject to CSP. Those tests could not have failed. Neither could a
 * test that asserted a hardcoded `connect-src` string, since the bug is
 * precisely that two independently-maintained copies of a policy drifted
 * from the code they exist to permit. So this reads BOTH policies off disk
 * and checks them against the module's own exported
 * `REVERSE_GEOCODE_ORIGINS` — add a third provider to `geoReverse.ts` and
 * both assertions fail until the policies follow.
 *
 * Proven, not assumed: deleting `connect-src` from either file fails "every
 * reverse-geocode origin is in connect-src" for that file, and deleting the
 * BigDataCloud origin from one of the two fails the byte-identical check as
 * well. Both were run red before this comment was written.
 *
 * A second describe block at the bottom applies the same rule to the
 * consent-gated tags in `public/consent.js`, which had the identical hole:
 * their scripts were permitted and their beacons were not.
 */
import fs from "node:fs";
import path from "node:path";
import { REVERSE_GEOCODE_ORIGINS } from "@/lib/geoReverse";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HEADERS_FILE = path.join(REPO_ROOT, "apps/web/public/_headers");
const MIDDLEWARE_FILE = path.join(REPO_ROOT, "apps/api/src/middleware/securityHeaders.ts");
const CONSENT_JS = path.join(REPO_ROOT, "apps/web/public/consent.js");

/** The `_headers` copy: one literal line under the `/*` rule. */
function cspFromHeadersFile(): string {
  const raw = fs.readFileSync(HEADERS_FILE, "utf8");
  const line = raw.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  if (line === undefined) throw new Error(`No Content-Security-Policy line in ${HEADERS_FILE}`);
  return line.slice(line.indexOf(":") + 1).trim();
}

/**
 * The Worker copy: a `["directive", ...].join("; ")` array, so it is
 * reconstructed rather than read as one literal. Comment lines and the
 * `"a" + "b"` continuation the `script-src` entry uses are both handled;
 * anything this fails to parse surfaces as a missing directive, which the
 * assertions below catch loudly rather than skipping.
 */
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
    // Concatenate the double-quoted string literals that make up this entry.
    const parts = withoutComments.match(/"((?:[^"\\]|\\.)*)"/g);
    if (parts === null) continue;
    directives.push(parts.map((p) => p.slice(1, -1)).join(""));
  }
  return directives.join("; ");
}

function connectSrc(csp: string): string {
  const directive = csp.split(";").find((d) => d.trim().startsWith("connect-src "));
  if (directive === undefined) {
    throw new Error(`CSP has no connect-src directive — it falls back to default-src, which blocks every cross-origin fetch:\n${csp}`);
  }
  return directive.trim();
}

describe("CSP permits the reverse-geocode providers (#132)", () => {
  it.each([
    ["apps/web/public/_headers", cspFromHeadersFile],
    ["apps/api/src/middleware/securityHeaders.ts", cspFromMiddleware],
  ])("%s lists every reverse-geocode origin in connect-src", (_name, read) => {
    const sources = connectSrc(read());
    for (const origin of REVERSE_GEOCODE_ORIGINS) {
      expect(sources).toContain(origin);
    }
    // Same-origin calls are the entire rest of the app's traffic.
    expect(sources).toContain("'self'");
  });

  /**
   * `securityHeaders.ts`'s own header comment says the two are "deliberately
   * identical", because `/item/:id` is served by the Worker and every other
   * route by the assets binding — a mismatch breaks exactly one route, which
   * is the hardest kind of breakage to notice. Nothing checked that until
   * now.
   */
  it("the two copies of the policy are byte-identical", () => {
    expect(cspFromMiddleware()).toBe(cspFromHeadersFile());
  });
});

/**
 * The same class of bug, one provider over.
 *
 * `consent.js` gates two third-party tags, and `script-src` permitted both
 * scripts — but a tag's useful traffic is its *beacon*, which is
 * `connect-src`. With `connect-src` covering only `'self'` and the two
 * geocoders, turning either provider on would have loaded the script and
 * then had the browser drop everything it tried to report. Silent, and
 * indistinguishable from "nobody visited": exactly the failure the reverse
 * geocoders shipped with above, and exactly what `launch-audit.md` §7 found
 * in the policy — a page telling visitors their page views were counted
 * while nothing counted them.
 *
 * Reading the hosts out of the `PROVIDERS` registry rather than hardcoding
 * them is the point. That array is already the single source of truth for
 * what may load (`test/guards/privacyPolicy.test.ts` checks the published
 * policy against it); this makes it the source of truth for what may *talk*
 * as well, so adding a third provider fails here until its endpoint is in
 * both policies.
 */
function consentProviderHosts(): string[] {
  const raw = fs.readFileSync(CONSENT_JS, "utf8");
  const block = /(?:var|let|const) PROVIDERS = \[([\s\S]*?)\n {2}\];/.exec(raw);
  if (block?.[1] === undefined) throw new Error(`No PROVIDERS array in ${CONSENT_JS}`);
  return [...block[1].matchAll(/host:\s*'([^']+)'/g)].map((m) => m[1] ?? "");
}

describe("CSP permits the consent-gated providers to report", () => {
  it("finds the provider registry (positive control)", () => {
    // Without this, an empty parse would make every assertion below pass
    // vacuously — the shape AGENTS.md's table is entirely made of.
    expect(consentProviderHosts().length).toBeGreaterThan(0);
  });

  it.each([
    ["apps/web/public/_headers", cspFromHeadersFile],
    ["apps/api/src/middleware/securityHeaders.ts", cspFromMiddleware],
  ])("%s lists every consent-gated provider host in connect-src", (_name, read) => {
    const sources = connectSrc(read());
    for (const host of consentProviderHosts()) {
      expect(sources).toContain(host);
    }
  });
});
