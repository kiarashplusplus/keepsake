/**
 * The font bytes resvg rasterises the share card with.
 *
 * ## Why these are not the fonts in `apps/web/public/fonts`
 *
 * Fraunces is a variable font whose design depends on four axes, and the
 * tokens ask display type for `opsz 144, SOFT 40, WONK 1`
 * (`packages/tokens/src/typography.ts`). **resvg 2.6.2 has no
 * `font-variation-settings` support** — that landed upstream in resvg 0.47.0,
 * two years after this build — so it renders a variable font at its `fvar`
 * DEFAULTS no matter what the SVG asks for. `Fraunces-VF.ttf` defaults to
 * `opsz 9 / SOFT 0`, the *text* cut: chunkier, lower contrast, blunter
 * serifs. The card would have been set in a different typeface from the app
 * it links to, and nothing would have reported an error.
 *
 * So the axes resvg cannot reach are baked in ahead of time. These two files
 * are `Fraunces-{,Italic-}VF.ttf` run through
 * `fontTools.varLib.instancer` with `opsz=144 SOFT=40 WONK=1` pinned and
 * `wght=100:900` left VARIABLE — `font-weight` is the one axis resvg does
 * honour (fontdb sets the `wght` coordinate from it), so keeping it live is
 * what lets `font-weight="600"` still mean something on the card.
 *
 * Regenerate with (see `docs/design/design-system.md`):
 *
 *   python -m fontTools.varLib.instancer apps/web/public/fonts/Fraunces-VF.ttf \
 *     opsz=144 SOFT=40 WONK=1 wght=100:900 \
 *     -o apps/api/src/og/fonts/Fraunces-Display-VF.ttf
 *
 * **If you regenerate them, re-run `node tools/og/measure-advances.mjs` and
 * paste the result into `text.ts`.** The card computes its own line breaks
 * from a table of advance widths measured off these exact files; the display
 * cut is up to 29% narrower per character than the text cut, so a stale table
 * silently mis-wraps every title.
 *
 * Courier Prime is not variable and is used as shipped. Note its name-table
 * family is `"Courier Prime"` WITH A SPACE, not the `CourierPrime` token
 * name — resvg falls back silently on a miss, so `card.ts` writes the spaced
 * form and `test/ogCardFonts.test.ts` asserts the two agree.
 *
 * ## Why they are imported, not fetched
 *
 * They could be read at runtime through the `ASSETS` binding, which would
 * cost nothing in bundle size. They are bundled instead because the browser
 * must never download them: they are a Worker-only rendering detail, and
 * putting them under `apps/web/public/fonts` would add ~290 KB to what every
 * visitor's browser sees offered for preload. `wrangler.toml`'s `[[rules]]`
 * block with `type = "Data"` is what turns these imports into `ArrayBuffer`s.
 */
import courierBold from "./fonts/CourierPrime-Bold.ttf";
import courierRegular from "./fonts/CourierPrime-Regular.ttf";
import frauncesItalic from "./fonts/Fraunces-Display-Italic-VF.ttf";
import fraunces from "./fonts/Fraunces-Display-VF.ttf";

/**
 * Built once per isolate. `Uint8Array` views over the imported buffers, in the
 * order resvg should consider them — the first family it can match wins, and
 * `defaultFontFamily` in `render.ts` names Fraunces explicitly anyway.
 */
let cached: Uint8Array[] | null = null;

export function cardFontBuffers(): Uint8Array[] {
  cached ??= [fraunces, frauncesItalic, courierRegular, courierBold].map((buf) => new Uint8Array(buf));
  return cached;
}

/**
 * The family names as they appear in each file's `name` table. `card.ts` must
 * write exactly these strings in `font-family`, and the guard test reads them
 * back out of the TTF binaries rather than trusting this list.
 */
export const CARD_FONT_FAMILIES = ["Fraunces", "Courier Prime"] as const;
