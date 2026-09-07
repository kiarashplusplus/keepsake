/**
 * Rasterises a share card inside the Worker: SVG in, JPEG bytes out.
 *
 * `card.ts` builds the SVG and knows nothing about resvg; this module owns
 * every runtime concern — wasm lifetime, fonts, photo resolution, and the
 * encode. The split is what lets `tools/og/render-samples.mjs` render the
 * exact production SVG in Node without dragging the Worker's bindings along.
 *
 * ## Why JPEG and not PNG
 *
 * Measured, not assumed. The same 1200x630 card with a real photograph in its
 * window is **377-536 KB as a PNG and 81-98 KB as a q82 JPEG.** PNG is
 * lossless and therefore stores photographic noise faithfully, which is
 * exactly the wrong trade for an image whose job is to be a thumbnail in a
 * chat bubble. WhatsApp is the binding constraint on unfurl image size, and
 * PNG spends the entire budget on detail nobody sees.
 *
 * resvg only emits PNG (`asPng()`), so this reads `rendered.pixels` — the raw
 * RGBA buffer — and encodes that. The PNG encode is skipped entirely rather
 * than performed and thrown away.
 *
 * ## Why the wasm is initialised lazily
 *
 * Workers enforce a **400 ms startup CPU budget**, and module-scope code runs
 * on the first request to *any* route in this Worker, not just this one.
 * Instantiating a 2.4 MB module at import time would put that cost on
 * `/api/*`, `/health` and the ASSETS catch-all, and a slow deploy would fail
 * startup rather than fail one card. So `initWasm` happens inside the handler,
 * memoised per isolate, with the memo cleared on rejection so a single
 * transient failure cannot poison an isolate for its lifetime.
 */
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasmModule from "@resvg/resvg-wasm/index_bg.wasm";
import { encode as encodeJpeg } from "jpeg-js";
import { buildItemCardSvg, CARD_HEIGHT, CARD_WIDTH, COVER_HREF, type CardInput } from "./card.js";
import { cardFontBuffers } from "./fonts.js";

/**
 * Quality 82: the knee of the curve for this card. 90 costs ~40% more bytes
 * for a difference invisible at unfurl sizes; 75 starts to ring around the
 * stamp's hard red edges and the Courier footer.
 */
const JPEG_QUALITY = 82;

let ready: Promise<void> | null = null;

/** Idempotent, per-isolate. See the file header on why this is not top-level. */
export function resvgReady(): Promise<void> {
  ready ??= initWasm(wasmModule).catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

export interface RenderCardInput extends CardInput {
  /** JPEG/PNG/GIF bytes for the cover photo. resvg cannot decode WebP. */
  cover: Uint8Array;
}

/**
 * Renders `input` to JPEG bytes.
 *
 * Throws if resvg cannot parse the SVG or decode the photo — callers are
 * expected to fall back to serving the raw photo rather than to retry. A
 * WebP cover is the realistic cause: `lib/imageSniff.ts` accepts WebP on
 * upload even though the official client always re-encodes to JPEG, so a
 * hand-rolled client can put one in R2.
 */
// `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: TS 5.9 types `BodyInit`
// against `ArrayBufferView<ArrayBuffer>` specifically, while a bare
// `Uint8Array`'s buffer is `ArrayBufferLike` (it could in principle be backed
// by a `SharedArrayBuffer`). Stating the narrower type here — which is what
// `new Uint8Array(...)` below actually produces — lets `routes/ogCard.ts`
// pass the bytes straight to `new Response()` with no cast. Same mismatch
// `test/helpers.ts`'s `fakeFile` documents, resolved rather than cast around.
export async function renderItemCard(input: RenderCardInput): Promise<Uint8Array<ArrayBuffer>> {
  await resvgReady();

  const svg = buildItemCardSvg(input);
  const resvg = new Resvg(svg, {
    font: { fontBuffers: cardFontBuffers(), defaultFontFamily: "Fraunces", loadSystemFonts: false },
  });

  // resvg defers only hrefs it recognises as remote, which is why `card.ts`
  // uses `https://*.invalid/` sentinels rather than a custom scheme — a
  // scheme it does not understand yields an EMPTY `imagesToResolve()` and a
  // blank photo window with no error at all. Verified against 2.6.2.
  for (const href of resvg.imagesToResolve()) {
    if (href === COVER_HREF) resvg.resolveImage(href, input.cover);
  }

  const rendered = resvg.render();
  const { data } = encodeJpeg(
    { data: rendered.pixels as unknown as Buffer, width: rendered.width, height: rendered.height },
    JPEG_QUALITY,
  );
  return new Uint8Array(data);
}

export { CARD_HEIGHT, CARD_WIDTH };
