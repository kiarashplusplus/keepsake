/**
 * The real photographs the UX baseline is captured against.
 *
 * `support/png.ts` synthesises a gradient, which is the right thing for the
 * functional specs: they assert that an upload survives the pipeline, and a
 * generated PNG keeps the size and colour under the test's control without
 * putting a binary in the repo. It is the wrong thing for a screenshot set.
 * This product's design is a photograph on a print on a table, so a capture
 * where every print holds the same rainbow gradient can show the layout and
 * the type and says nothing at all about the thing the layout is for — how a
 * real photograph sits in the frame, whether the crop is kind to a portrait
 * shot, whether the caption still reads over a busy image, whether the
 * tabletop looks warm or muddy next to real colour.
 *
 * So the six catalogue keepsakes and the one the give walkthrough posts each
 * get a photograph of roughly the object their story describes. The aspect
 * ratios are deliberately left as shot — five portrait, one wide — because
 * `clampCardAspectRatio()` is exactly the code a uniform fixture would stop
 * exercising.
 *
 * Provenance and licence: `../fixtures/photos/README.md`.
 */
import fs from "node:fs";
import path from "node:path";

const PHOTO_DIR = path.resolve(__dirname, "../fixtures/photos");

export interface DemoPhoto {
  /** Basename in `e2e/fixtures/photos`, and the key `demoCatalog.ts` uses. */
  key: string;
  /** Dimensions of the full image, as `PUT /api/photos` wants them. The API
   * stores these rather than decoding, and the feed lays a card out from the
   * ratio, so they have to match the file. */
  width: number;
  height: number;
  /** Encoded from the real file with the same `blurhash` package the app
   * decodes with, rather than one constant reused for every photo: the
   * placeholder is what shows while a photo decodes, and a fixture that
   * blurs to the wrong colour would misrepresent the one moment it exists
   * for. Regenerate with the script in the fixtures README. */
  blurhash: string;
}

export const DEMO_PHOTOS = {
  kettle: { key: "kettle", width: 900, height: 1200, blurhash: "L7B::6~AyDrq%0xuV@R5ysE2jFo}" },
  brooch: { key: "brooch", width: 800, height: 1200, blurhash: "L26kL]-;XA~q~qs:xv-;00RP%2Io" },
  letters: { key: "letters", width: 800, height: 1200, blurhash: "LCK1wO_3?c9Z.78_~WxaEL0KDix[" },
  plane: { key: "plane", width: 901, height: 1200, blurhash: "L5BC#@E+^+~B04};RkIo580fRj%1" },
  records: { key: "records", width: 1200, height: 745, blurhash: "LQF=:V~q_3_3.6RjV[WBRjofs:oL" },
  quilt: { key: "quilt", width: 800, height: 1200, blurhash: "LmJ8O$D%Rjo2_NM{M{ofbHbHWBj@" },
  /** Not in the catalogue: the keepsake the give walkthrough types in and
   * then deletes, so the feed both projects photograph stays the fixed six. */
  butterdish: { key: "butterdish", width: 900, height: 1200, blurhash: "LHDlcp~VNdo}9G4:E1ay4o%L-:V@" },
} as const satisfies Record<string, DemoPhoto>;

export type DemoPhotoKey = keyof typeof DEMO_PHOTOS;

/** Read lazily rather than at import: `png.ts`'s encoder cost nothing to hold,
 * these are ~1.2 MB and most specs want none of them. */
export function readDemoPhoto(photo: DemoPhoto): Buffer {
  return fs.readFileSync(path.join(PHOTO_DIR, `${photo.key}.jpg`));
}

/** The pre-scaled 400px copy. The give flow's browser resizes its own thumb
 * from the file it is handed; this is for `api.ts`, which posts both halves
 * directly and would otherwise send a 1200px image as the thumbnail. */
export function readDemoThumb(photo: DemoPhoto): Buffer {
  return fs.readFileSync(path.join(PHOTO_DIR, `${photo.key}.thumb.jpg`));
}
