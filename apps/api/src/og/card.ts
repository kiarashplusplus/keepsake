/**
 * The per-listing share card: a 1200x630 SVG in the v3 "Polaroids on a table"
 * language, rasterised to PNG by resvg (`og/render.ts` in the Worker,
 * `tools/og/render-samples.mjs` offline). This module is **pure** — a string
 * in, a string out, no `Env`, no hono, no resvg — so the preview harness and
 * the Worker render byte-identical output from the same code.
 *
 * It extends `apps/site/og/og-default.svg`, which is the source of truth for
 * the identity (kraft table with fibre noise, white prints tilted and taped,
 * black ink, red rubber stamps, Fraunces + Courier Prime). Read that file
 * before changing anything here.
 *
 * ## The one rule this file exists to honour
 *
 * `packages/tokens/src/colors.ts` states it: no text is ever set directly on
 * the table. Every glyph on this card sits on a paper object — a print's
 * frame, a print's chin, or an index card. That constraint is what makes the
 * three compositions below genuinely different layouts rather than three
 * arrangements of the same one.
 *
 * ## The arbitrary-aspect-ratio problem
 *
 * A giver's photo is any shape; the card is fixed at 1.91:1. Rather than
 * fitting the photo to the card (which letterboxes portraits into slivers),
 * each composition gives the photo a **fixed-ratio window** inside a paper
 * object and slices into it: `preserveAspectRatio="xMidYMid slice"` is
 * centre-crop-to-fill, and the `clipPath` is what stops the overflow reaching
 * the table. One code path for portrait, landscape and square — no per-photo
 * branching anywhere.
 *
 * ## What resvg cannot do, which shapes the type
 *
 * resvg 2.6.2 predates `font-variation-settings` support (added upstream in
 * resvg 0.47.0), so a variable font renders at its `fvar` DEFAULTS whatever
 * the SVG asks for. Fraunces-VF defaults to `opsz 9 / SOFT 0 / WONK 1` — the
 * 9pt text cut, not the 144pt display cut this design wants. `font-weight` IS
 * honoured (fontdb sets the `wght` coordinate). The fix is upstream of this
 * file: `og/fonts.ts` ships cuts instanced at `opsz=144 SOFT=60 WONK=1` with
 * `wght` left variable. The `font-variation-settings` attributes below are
 * therefore written for correctness and future resvg versions, and are inert
 * today — do not delete them, and do not trust them either.
 *
 * Note `font-family="Courier Prime"` **with a space**: that is the family in
 * the font's own name table, not the `CourierPrime` token name. resvg falls
 * back silently on a miss. Guarded by a test that reads the TTF name records.
 */
import { colorsLight } from "@keepsake/tokens/colors";
import { motion } from "@keepsake/tokens/motion";
import { tiltDegForId } from "@keepsake/tokens/tilt";
import { cardStoryExcerpt, escapeXml, isRenderable, measureText, wrapText } from "./text.js";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/**
 * The `href` each photo is referenced by. `og/render.ts` matches these exact
 * strings in resvg's `imagesToResolve()` and hands back the R2 bytes, which
 * avoids base64's 33% inflation on the hot path.
 *
 * They must be `https://` URLs, and that is not cosmetic: resvg only defers
 * hrefs it recognises as remote. Measured against resvg-wasm 2.6.2 —
 * `ks:cover`, `cover.jpg` and `/cover.jpg` all return an EMPTY
 * `imagesToResolve()` and render as a blank window with no error, while an
 * `https://` href is deferred correctly. A custom scheme reads as the safer
 * choice and silently produces a photo-less card.
 *
 * `.invalid` is the RFC 2606 reserved TLD, so if a resolution step is ever
 * skipped the fetch cannot reach a real host — the image is simply absent.
 */
export const COVER_HREF = "https://cover.invalid/photo.jpg";
export const SECOND_HREF = "https://second.invalid/photo.jpg";

export type CardVariant = "a" | "b" | "c";

export interface CardInput {
  id: string;
  title: string;
  story: string;
  categoryLabel: string;
  /** Already formatted as `metaLine()` does it: "Somerville, MA". Never a postcode. */
  place: string;
  /** `approved` renders the FREE stamp, `given` renders GIVEN. */
  status: "approved" | "given";
  /** True when a second photo exists — only composition C uses it. */
  hasSecondPhoto: boolean;
}

const c = colorsLight;

/* ------------------------------------------------------------------ *
 * Shared pieces of the vocabulary
 * ------------------------------------------------------------------ */

/**
 * The table. `feTurbulence` is the same fibre texture `og-default.svg` uses
 * and `KraftTable.web.tsx` renders in the app.
 *
 * It is also, measurably, the most expensive thing on this card in PNG bytes:
 * dense pseudo-random noise across 756,000 pixels is close to worst-case for
 * deflate. `baseFrequency` here is coarser than `og-default.svg`'s
 * `0.012 0.9` for exactly that reason — see the byte table that
 * `tools/og/render-samples.mjs` prints. If the budget still bites, the next
 * step is confining the filter to the margins outside the paper objects.
 */
function table(): string {
  return `
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${c.table}"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${c.tableEdge}" filter="url(#fibre)"/>`;
}

/** Two strips of tape at the top corners of a print, angled apart so the pair
 * never reads as a machine-placed pair. `w`/`h` are the print's half-extents. */
function tape(halfW: number, halfH: number): string {
  return `
    <rect x="${-halfW + 20}" y="${-halfH - 20}" width="90" height="40" fill="${c.tape}" transform="rotate(-14 ${-halfW + 65} ${-halfH})"/>
    <rect x="${halfW - 110}" y="${-halfH - 20}" width="90" height="40" fill="${c.tape}" transform="rotate(11 ${halfW - 65} ${-halfH})"/>`;
}

/**
 * The red rubber stamp. Doubled stroke (a heavy outer rule and a hairline
 * inset) is what reads as ink pressed through a rubber die rather than as a
 * vector rectangle — the same treatment `ui/Stamp.tsx` uses.
 */
function stamp(label: string, rotateDeg: number): string {
  const size = 28;
  const tracking = 6;
  const textW = measureText(label, "courier", size, tracking);
  const halfW = Math.max(70, textW / 2 + 26);
  return `
    <g transform="rotate(${rotateDeg})">
      <rect x="${-halfW}" y="-32" width="${halfW * 2}" height="64" fill="none" stroke="${c.stamp}" stroke-width="5"/>
      <rect x="${-halfW + 8}" y="-24" width="${halfW * 2 - 16}" height="48" fill="none" stroke="${c.stamp}" stroke-width="1.5" opacity="0.55"/>
      <text x="0" y="11" font-family="Courier Prime" font-weight="700" font-size="${size}" letter-spacing="${tracking}" fill="${c.stampText}" text-anchor="middle">${escapeXml(label)}</text>
    </g>`;
}

function stampLabel(status: CardInput["status"]): string {
  return status === "given" ? "GIVEN" : "FREE";
}

/** The typewritten footer that appears on every card, as on `og-default.svg`. */
function footer(x: number, y: number): string {
  return `<text x="${x}" y="${y}" font-family="Courier Prime" font-weight="700" font-size="18" letter-spacing="3" fill="${c.foilText}">KEEPSAKE.ING</text>`;
}

/** The photo, slicing into a fixed-ratio window. See the file header. */
function photoWindow(href: string, x: number, y: number, w: number, h: number, clipId: string): string {
  return `
    <clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>
    <image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="rgba(0,0,0,0.10)" stroke-width="1"/>`;
}

/** Multi-line `<text>` as one element per line — resvg has no automatic
 * wrapping and its `<tspan dy>` handling is happier with explicit `y`. */
function lines(
  items: readonly string[],
  opts: { x: number; y: number; leading: number; family: string; size: number; fill: string; weight?: number; style?: string; tracking?: number; variation?: string },
): string {
  const weight = opts.weight === undefined ? "" : ` font-weight="${opts.weight}"`;
  const style = opts.style === undefined ? "" : ` font-style="${opts.style}"`;
  const tracking = opts.tracking === undefined ? "" : ` letter-spacing="${opts.tracking}"`;
  const variation = opts.variation === undefined ? "" : ` font-variation-settings="${opts.variation}"`;
  return items
    .map(
      (line, i) =>
        `<text x="${opts.x}" y="${opts.y + i * opts.leading}" font-family="${opts.family}"${weight}${style}${tracking}${variation} font-size="${opts.size}" fill="${opts.fill}">${escapeXml(line)}</text>`,
    )
    .join("\n      ");
}

const DISPLAY_VARIATION = "'opsz' 144, 'SOFT' 40, 'WONK' 1";

/**
 * The title, or nothing.
 *
 * resvg draws NOTHING for a glyph no loaded font covers — not tofu, just
 * empty space — so a Cyrillic or CJK title would leave a silent hole that
 * looks like a rendering bug nobody can diagnose. Both card faces are
 * Latin-only, so an unrenderable title is dropped outright and the card falls
 * back to photo + stamp + footer, which is honest about what it can show.
 */
function titleLines(title: string, maxWidth: number, size: number, maxLines: number): string[] {
  if (!isRenderable(title)) return [];
  return wrapText(title, { font: "fraunces", fontSize: size, maxWidth, maxLines });
}

function excerptLines(story: string, maxWidth: number, size: number, maxLines: number, chars: number): string[] {
  const excerpt = cardStoryExcerpt(story, chars);
  if (!isRenderable(excerpt)) return [];
  return wrapText(excerpt, { font: "fraunces", fontSize: size, maxWidth, maxLines });
}

/* ------------------------------------------------------------------ *
 * Composition A — "The print and the index card"
 * ------------------------------------------------------------------ */

/**
 * Two paper objects, counter-leaning so the pair reads as scattered rather
 * than as a two-column layout: a taped square print on the left, and the
 * story on a kraft index card on the right — the same index-card surface an
 * input is cut from in the app (`colors.surface`), so the card looks like the
 * product rather than like a generic OG template.
 */
function compositionA(input: CardInput): string {
  const tilt = tiltDegForId(input.id, motion.tiltRangeDeg);
  const title = titleLines(input.title, 480, 44, 3);
  const story = excerptLines(input.story, 480, 22, title.length >= 3 ? 2 : 3, 160);
  const titleTop = -160;
  const ruleY = titleTop + title.length * 50 + 8;
  const storyTop = ruleY + 40;

  return `
  <g transform="translate(330,306) rotate(${tilt.toFixed(2)})">
    <rect x="-250" y="-281" width="500" height="562" fill="${c.print}" stroke="rgba(0,0,0,0.08)" stroke-width="2"/>
    ${photoWindow(COVER_HREF, -222, -253, 444, 444, "winA")}
    <text x="-222" y="242" font-family="Courier Prime" font-weight="700" font-size="16" letter-spacing="3" fill="${c.foilText}">${escapeXml(input.categoryLabel.toUpperCase())}</text>
    ${tape(250, 281)}
  </g>

  <g transform="translate(830,315) rotate(${(-0.6 * tilt).toFixed(2)})">
    <rect x="-270" y="-250" width="540" height="500" fill="${c.surface}" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>
    <clipPath id="cardA"><rect x="-250" y="-230" width="500" height="460"/></clipPath>
    <g clip-path="url(#cardA)">
      ${lines(title, { x: -240, y: titleTop, leading: 50, family: "Fraunces", size: 44, fill: c.ink, weight: 600, tracking: -1, variation: DISPLAY_VARIATION })}
      <rect x="-240" y="${ruleY}" width="480" height="2" fill="${c.rule}"/>
      ${lines(story, { x: -240, y: storyTop, leading: 30, family: "Fraunces", size: 22, fill: c.pencil, style: "italic" })}
    </g>
    <text x="-240" y="180" font-family="Courier Prime" font-size="18" fill="${c.ink}">${escapeXml(input.place)}</text>
    <g transform="translate(150,170)">${stamp(stampLabel(input.status), -7)}</g>
    ${footer(-240, 225)}
  </g>`;
}

/* ------------------------------------------------------------------ *
 * Composition B — "One print, caption on the frame"
 * ------------------------------------------------------------------ */

/**
 * Literally `og-default.svg`'s composition — one big taped print, a second
 * peeking out behind — with the empty left half filled by the photo and the
 * type set on the same white frame. Maximum brand continuity: a card in this
 * shape is instantly the same object as the default one. The trade is that
 * everything shares one column of white, so a long title pushes on the story.
 */
function compositionB(input: CardInput): string {
  const tilt = tiltDegForId(input.id, motion.tiltRangeDeg);
  const title = titleLines(input.title, 470, 42, 3);
  const story = excerptLines(input.story, 470, 21, title.length >= 3 ? 2 : 3, 150);
  const titleTop = -140;
  const storyTop = titleTop + title.length * 48 + 30;

  return `
  <g transform="translate(838,150) rotate(6)">
    <rect x="-190" y="-140" width="380" height="330" fill="${c.print}"/>
    <rect x="-175" y="-125" width="350" height="255" fill="${c.tableEdge}"/>
  </g>

  <g transform="translate(600,315) rotate(${tilt.toFixed(2)})">
    <rect x="-490" y="-255" width="980" height="510" fill="${c.print}" stroke="rgba(0,0,0,0.08)" stroke-width="2"/>
    ${photoWindow(COVER_HREF, -460, -210, 380, 420, "winB")}
    <clipPath id="cardB"><rect x="-50" y="-235" width="500" height="400"/></clipPath>
    <g clip-path="url(#cardB)">
      <text x="-50" y="-185" font-family="Courier Prime" font-weight="700" font-size="16" letter-spacing="3" fill="${c.foilText}">${escapeXml(input.categoryLabel.toUpperCase())}</text>
      ${lines(title, { x: -52, y: titleTop, leading: 48, family: "Fraunces", size: 42, fill: c.ink, weight: 600, tracking: -1, variation: DISPLAY_VARIATION })}
      ${lines(story, { x: -50, y: storyTop, leading: 29, family: "Fraunces", size: 21, fill: c.pencil, style: "italic" })}
    </g>
    <text x="-50" y="185" font-family="Courier Prime" font-size="18" fill="${c.ink}">${escapeXml(input.place)}</text>
    <g transform="translate(340,175)">${stamp(stampLabel(input.status), -7)}</g>
    ${footer(-460, 240)}
    ${tape(490, 255)}
  </g>`;
}

/* ------------------------------------------------------------------ *
 * Composition C — "Contact sheet"
 * ------------------------------------------------------------------ */

/**
 * Photo-dominant and text-minimal, designed for how small an iMessage
 * thumbnail actually is: at that size a story excerpt is unreadable noise, so
 * this one spends the space on the object instead. All type lives on the
 * front print's chin. Uses the listing's second photo on the back print when
 * there is one — the contact-sheet read — and a blank kraft print when there
 * isn't, exactly as `og-default.svg` does.
 */
function compositionC(input: CardInput): string {
  const tilt = tiltDegForId(input.id, motion.tiltRangeDeg);
  // The title column stops short of the stamp's left edge rather than running
  // the full width of the chin — the stamp is pressed ON the print, so type
  // sliding under it reads as a bug, not as layering.
  const title = titleLines(input.title, 450, 32, 2);

  // With no second photo there is no back print at all. `og-default.svg` fills
  // its back print with flat kraft, which works there because the front print
  // covers all but a sliver; here the back print is largely exposed, and a
  // bare kraft rectangle reads as a missing image rather than as a second
  // photograph face-down on the table.
  const back = input.hasSecondPhoto
    ? `
  <g transform="translate(905,175) rotate(6)">
    <rect x="-170" y="-150" width="340" height="300" fill="${c.print}" stroke="rgba(0,0,0,0.06)" stroke-width="2"/>
    ${photoWindow(SECOND_HREF, -142, -122, 284, 244, "winC2")}
  </g>`
    : "";

  return `${back}

  <g transform="translate(505,308) rotate(${tilt.toFixed(2)})">
    <rect x="-340" y="-250" width="680" height="500" fill="${c.print}" stroke="rgba(0,0,0,0.08)" stroke-width="2"/>
    ${photoWindow(COVER_HREF, -310, -222, 620, 340, "winC")}
    <clipPath id="chinC"><rect x="-310" y="128" width="620" height="122"/></clipPath>
    <g clip-path="url(#chinC)">
      ${lines(title, { x: -310, y: title.length > 1 ? 166 : 184, leading: 36, family: "Fraunces", size: 32, fill: c.ink, weight: 600, tracking: -0.6, variation: DISPLAY_VARIATION })}
    </g>
    <text x="-310" y="228" font-family="Courier Prime" font-size="16" fill="${c.pencil}">${escapeXml(input.place)}</text>
    ${footer(-100, 228)}
    <g transform="translate(250,178)">${stamp(stampLabel(input.status), -6)}</g>
    ${tape(340, 250)}
  </g>`;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

const COMPOSITIONS: Record<CardVariant, (input: CardInput) => string> = {
  a: compositionA,
  b: compositionB,
  c: compositionC,
};

export function buildItemCardSvg(input: CardInput, variant: CardVariant = "a"): string {
  const body = (COMPOSITIONS[variant] ?? compositionA)(input);
  return `<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="fibre" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.02 0.7" numOctaves="2" seed="7" stitchTiles="stitch" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0"/>
    </filter>
  </defs>
${table()}
${body}
</svg>`;
}
