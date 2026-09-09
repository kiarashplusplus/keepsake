#!/usr/bin/env node
/**
 * Per-route indexing metadata for the exported HTML, plus the `404.html`
 * Cloudflare's `not_found_handling = "404-page"` serves for a miss.
 *
 * Everything here is a build-time edit of `dist/**\/*.html` for the same
 * reason `fix-html-head.mjs` is: it is deterministic, it costs nothing per
 * request, and `app/+html.tsx` cannot do it — that file is ONE shell shared
 * by every exported route, so a `<link rel="canonical">` written there says
 * every route is a duplicate of `/` (the reason it deliberately carries
 * none; see its comment and `test/guards/rootOpenGraph.test.ts`). The
 * exported *files* are per-route, so this is the first place a per-route
 * value can be written truthfully.
 *
 * Measured against the live site on 2026-09-09 — the first pass in
 * `docs/runbooks/seo-audit.md` that could reach `keepsake.ing` from the
 * agent container. What it found, and what each part below answers:
 *
 * 1. **`https://keepsake.ing/<anything>` answered `200` with the homepage's
 *    bytes** — identical ETag to `/`. `not_found_handling =
 *    "single-page-application"` serves `index.html` for every miss, so the
 *    site had an unbounded space of crawlable URLs that were all soft 404s
 *    and all duplicates of `/`. `404.html` below is what turns that into a
 *    real 404 once `wrangler.toml` asks for `404-page` handling.
 * 2. **No `<link rel="canonical">` and no `og:url` on any Expo route.**
 *    `/about`, `/privacy` and `/terms` (hand-written, `apps/site/public`)
 *    have carried both all along; `/`, `/welcome` and `/give` had neither.
 * 3. **`/give/details`, `/give/story`, `/give/review` and `/give/email` were
 *    indexable**, four mid-flow form steps with the site-wide description.
 *    A searcher landing on step three of a form with no state in it gets
 *    nothing; `noindex, follow` keeps the link equity and drops the result.
 * 4. **`/welcome` unfurled as the site default** ("Keepsake" / "Give a
 *    keepsake a second life.") while its `<meta name="description">` was its
 *    own — the OG tags come from the shell and `RouteHead` does not touch
 *    them. Any page that has its own description now has its own OG copy.
 * 5. **`/_sitemap` was live at `200`** — expo-router's built-in route index,
 *    which lists every route in the app including `/admin` and `/bulk`. It
 *    is a development affordance that has no business on a public deploy, so
 *    it is deleted from the export rather than merely noindexed.
 *
 * ## Why the route lists are literal
 *
 * `INDEXABLE` and `NEVER_TOUCH` are written out rather than derived because
 * getting either wrong is silent and expensive in opposite directions. A
 * route that quietly falls into the noindex default disappears from search
 * with nothing to see in a diff; a `<meta name="robots" content="noindex">`
 * that reaches `item/[id].html` would deindex **every listing page on the
 * site** — the Worker's rewriter (`apps/api/src/routes/item.ts`) strips the
 * shell's `title`/`description`/`og:*`/`twitter:*`/canonical before adding
 * its own, but it does not strip a robots meta, so one would survive into
 * every rewritten listing. `NEVER_TOUCH` is that guard, and
 * `test/guards/seoHtml.test.ts` asserts it against the real `dist/`.
 *
 * A new route therefore defaults to `noindex` and someone has to add it to
 * `INDEXABLE` on purpose. That is the safe direction for an app whose
 * indexable surface is five pages and whose other twenty are flow steps
 * behind a token.
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const dist = resolve(new URL(".", import.meta.url).pathname, "../dist");

/**
 * The origin every canonical and `og:url` is built from.
 *
 * Hardcoded, matching `app/+html.tsx`'s `og:image` and
 * `apps/site/public/{about,privacy,terms}.html`'s own canonicals, rather
 * than read from `EXPO_PUBLIC_SITE_URL` — which is `""` in production by
 * design (same-origin, `src/lib/config.ts`) and would produce a canonical of
 * `/welcome` with no origin. See `+html.tsx`'s OG comment for why a preview
 * export pointing at production here is the intended posture and not a leak:
 * preview serves `Disallow: /` and an unconditional `X-Robots-Tag: noindex,
 * nofollow`, so nothing on it is ever asked what its canonical is.
 */
const ORIGIN = "https://keepsake.ing";

/**
 * The exported Expo routes that belong in a search index, by route path.
 *
 * `/about`, `/privacy` and `/terms` are not here because they are not Expo's
 * — `apps/site/public/*.html` carry their own canonical and `og:url`, and
 * `copy-site.mjs` runs after this script. `/item/:id` is not here because
 * its canonical is per-listing and the Worker writes it.
 *
 * `/give` is the one judgement call. It is step one of the give flow rather
 * than a marketing page, and its `<title>` ("Give a keepsake: Photos") reads
 * like the step it is — but it is also the target of the "Give something"
 * call to action on all three static pages, so dropping it from the index
 * would mean the one page this product converts on is unreachable from
 * search. It stays indexable; its interior steps do not.
 */
const INDEXABLE = new Set(["/", "/welcome", "/give"]);

/**
 * Files this script must not add a robots meta to, at any cost.
 *
 * `item/[id].html` is the shell the Worker rewrites into every listing page.
 * See the module comment: a noindex here is not "one page missing", it is
 * the entire content surface of the site, and it would look like a one-line
 * data change in a diff.
 */
const NEVER_TOUCH = new Set(["item/[id].html"]);

/** expo-router's built-in route index. Deleted, not noindexed — see the
 * module comment. */
const DEV_ONLY = ["_sitemap.html"];

/** `<title>…</title>`, whether or not react-helmet claimed it. */
const TITLE = /<title\b[^>]*>([^<]*)<\/title>/i;
/** The page's own description — `data-rh="true"` is react-helmet's mark, so
 * this matches only a `RouteHead` one and never the shell's static default. */
const ROUTE_DESCRIPTION = /<meta data-rh="true" name="description"[^>]*content="([^"]*)"[^>]*\/?>/i;

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

/**
 * The URL path a given exported file is served at, or `null` for a dynamic
 * route whose path is not knowable at build time.
 *
 * Mirrors `wrangler.toml`'s `html_handling = "drop-trailing-slash"`: under
 * it `give/index.html` is served at `/give`, not `/give/`, so that is the
 * canonical this writes and the URL `apps/site`'s pages already link to.
 */
export function routePathFor(relativeFile) {
  if (relativeFile.includes("[")) return null;
  const withoutExtension = relativeFile.replace(/\.html$/, "").split(sep).join("/");
  if (withoutExtension === "index") return "/";
  const withoutIndex = withoutExtension.replace(/\/index$/, "");
  return `/${withoutIndex}`;
}

/** Attribute-safe text for a `content="…"` / `href="…"` value. */
function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Replaces one `<meta property="…">`'s content in place.
 *
 * In place rather than appended: a crawler takes the FIRST `og:title` it
 * sees, so appending a better one after the shell's default changes nothing
 * — the same trap `fix-html-head.mjs` exists to keep out of `dist/` for
 * `<title>`, and the reason `apps/api/src/routes/item.ts` removes the
 * shell's tags before adding its own rather than just adding.
 */
function replaceMetaProperty(html, property, content) {
  const pattern = new RegExp(`(<meta property="${property}" content=")[^"]*("\\s*/?>)`, "i");
  if (!pattern.test(html)) return html;
  return html.replace(pattern, `$1${escapeAttribute(content)}$2`);
}

function main() {
  for (const name of DEV_ONLY) {
    const p = join(dist, name);
    try {
      rmSync(p);
      console.log(`[seo-html] removed ${name} (development-only route)`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  if (htmlFiles(dist).length === 0) {
    console.error("[seo-html] no HTML found in dist — did the export run?");
    process.exit(1);
  }

  // `404.html` is a copy of expo-router's own `+not-found` export, so the
  // page a miss lands on is the app's not-found screen with its real markup
  // — the same thing a visitor saw before, only now with a truthful status
  // code under it. Written before the loop below so it picks up the robots
  // meta with every other non-indexable page.
  const notFound = join(dist, "+not-found.html");
  let notFoundHtml;
  try {
    notFoundHtml = readFileSync(notFound, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.error("[seo-html] dist/+not-found.html missing — expo-router did not export app/+not-found.tsx");
    process.exit(1);
  }
  writeFileSync(join(dist, "404.html"), notFoundHtml);
  console.log("[seo-html] wrote 404.html from +not-found.html");

  let canonicalised = 0;
  let noindexed = 0;
  let ogRewritten = 0;
  const indexableSeen = new Set();

  const files = htmlFiles(dist);
  for (const file of files) {
    const rel = relative(dist, file).split(sep).join("/");
    const before = readFileSync(file, "utf8");
    let html = before;

    if (!/<\/head>/i.test(html)) {
      console.error(`[seo-html] ${rel} has no </head> to write into`);
      process.exit(1);
    }

    const routePath = routePathFor(rel);
    const indexable = routePath !== null && INDEXABLE.has(routePath);
    if (indexable) indexableSeen.add(routePath);

    const inserts = [];

    if (indexable) {
      // One absolute URL, declared twice: `rel="canonical"` is what a search
      // engine consolidates on, `og:url` is what an unfurler shows and what
      // Facebook keys its own cache by. `og:url` is a rewrite rather than an
      // insert only when the shell already declares one — it does not today,
      // so this appends it.
      const url = `${ORIGIN}${routePath === "/" ? "/" : routePath}`;
      inserts.push(`<link rel="canonical" href="${escapeAttribute(url)}"/>`);
      inserts.push(`<meta property="og:url" content="${escapeAttribute(url)}"/>`);
      canonicalised += 1;

      // A page with its own description gets its own OG copy too. Without
      // this, `/welcome` — whose description is three sentences about what
      // the product is — unfurled in iMessage and Slack as the bare site
      // default, because `RouteHead` writes `<title>`/`description` and
      // nothing else.
      const routeDescription = ROUTE_DESCRIPTION.exec(html)?.[1];
      if (routeDescription !== undefined) {
        const title = TITLE.exec(html)?.[1];
        let rewritten = replaceMetaProperty(html, "og:description", decodeEntities(routeDescription));
        if (title !== undefined && title.trim() !== "") {
          rewritten = replaceMetaProperty(rewritten, "og:title", decodeEntities(title));
        }
        if (rewritten !== html) {
          html = rewritten;
          ogRewritten += 1;
        }
      }
    } else if (!NEVER_TOUCH.has(rel)) {
      // `follow`, not `noindex, nofollow`: these pages link to `/`, `/about`
      // and the rest through the shared header and footer, and there is no
      // reason to tell a crawler to stop there. The header equivalent for
      // the routes behind a token (`/admin`, `/bulk`, `/mine`, `/recover`,
      // `/withdraw`, `/confirm`) is `X-Robots-Tag` from
      // `apps/api/src/index.ts`; this is the same answer written into the
      // bytes, which is the half that survives a request the Worker never
      // sees.
      inserts.push('<meta name="robots" content="noindex, follow"/>');
      noindexed += 1;
    }

    if (inserts.length > 0) html = html.replace(/<\/head>/i, `${inserts.join("")}</head>`);
    if (html !== before) writeFileSync(file, html);
  }

  const missing = [...INDEXABLE].filter((p) => !indexableSeen.has(p));
  if (missing.length > 0) {
    // A route in `INDEXABLE` that no exported file matches means a route was
    // renamed or removed and this list did not follow — which would show up
    // as a page silently dropping out of the sitemap and the index, with
    // nothing failing.
    console.error(`[seo-html] INDEXABLE names ${missing.join(", ")}, which no exported page serves`);
    process.exit(1);
  }

  console.log(
    `[seo-html] ${files.length} page(s): ${canonicalised} canonical + og:url, ${ogRewritten} with per-route OG copy, ${noindexed} noindexed`,
  );
}

/** The exported HTML is escaped markup; an attribute value read back out of
 * it has to be decoded before being re-escaped into a different attribute,
 * or `they&#x27;re` ships as `they&amp;#x27;re`. Only the five references an
 * HTML serializer produces are possible here. */
export function decodeEntities(value) {
  return value
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
