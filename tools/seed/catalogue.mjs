/**
 * The keepsakes `seed.mjs` posts, and the photographs they are posted with.
 *
 * ## Why the photographs come from `apps/web/e2e/fixtures/photos`
 *
 * That directory already holds seven real photographs, licensed for this use
 * (Pexels License — provenance and licence per file in its own README), each
 * downscaled to 1200px with a 400px thumbnail beside it, and each with the
 * `width`/`height`/`blurhash` the API wants already measured against the real
 * bytes. `PUT /api/photos` stores those three values rather than decoding the
 * image, so they have to be right: a wrong ratio lays the card out wrong and a
 * wrong blurhash shows the wrong colour in the moment before the photo
 * decodes.
 *
 * Copying the files here would duplicate 1.2 MB and, worse, duplicate the
 * measurements — two copies of a number that must match one set of bytes.
 * Reading them across the workspace instead means this catalogue and the UX
 * baseline always describe the same photographs. `catalogue.test.mjs` fails if
 * the numbers below ever drift from `e2e/support/demoPhotos.ts`, which is the
 * only thing that could silently break by reaching across like this.
 *
 * **This is the ceiling on catalogue size: seven photographs, so seven
 * keepsakes.** A feed with the same photo on two cards reads as broken, so
 * growing the catalogue means adding photographs first — see
 * `docs/runbooks/seed-catalogue.md` for how, and for `--photos`, which points
 * this at a directory of your own instead.
 *
 * ## Why the stories are not `demoCatalog.ts`'s stories
 *
 * The UX baseline's six exist to be *identical* between captures. These exist
 * to fill a feed someone browses. Sharing the text would tie a change in what
 * the demo marketplace says to a screenshot diff in `docs/qa/baseline/`, which
 * is a coupling nobody would expect to find.
 *
 * ## Postcodes
 *
 * The three the rest of this repo already uses: `apps/api/test/helpers.ts`'s
 * `seedStandardPostalCodes()` and the e2e harness's `global-setup.mjs` seed
 * exactly these, so `--env local` works against a stack that has no GeoNames
 * table loaded, and all three are real rows in the bundled seed so they resolve
 * on preview and production too. 02144 and 02139 are 1.7 miles apart; 01608 is
 * ~37 miles away, i.e. outside the feed's default 25-mile radius — so a seeded
 * feed has something for the radius filter to actually do.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_PHOTO_DIR = path.join(REPO_ROOT, "apps", "web", "e2e", "fixtures", "photos");

/**
 * `<key>.jpg` + `<key>.thumb.jpg` in the photo directory, with the dimensions
 * of the full image and a blurhash encoded from it with the same `blurhash`
 * package the app decodes with. Kept in step with `demoPhotos.ts` by
 * `catalogue.test.mjs`.
 */
export const PHOTOS = {
  kettle: { width: 900, height: 1200, blurhash: "L7B::6~AyDrq%0xuV@R5ysE2jFo}" },
  brooch: { width: 800, height: 1200, blurhash: "L26kL]-;XA~q~qs:xv-;00RP%2Io" },
  letters: { width: 800, height: 1200, blurhash: "LCK1wO_3?c9Z.78_~WxaEL0KDix[" },
  plane: { width: 901, height: 1200, blurhash: "L5BC#@E+^+~B04};RkIo580fRj%1" },
  records: { width: 1200, height: 745, blurhash: "LQF=:V~q_3_3.6RjV[WBRjofs:oL" },
  quilt: { width: 800, height: 1200, blurhash: "LmJ8O$D%Rjo2_NM{M{ofbHbHWBj@" },
  butterdish: { width: 900, height: 1200, blurhash: "LHDlcp~VNdo}9G4:E1ay4o%L-:V@" },
};

/**
 * Seven keepsakes. Written the way the product asks a giver to write — what
 * the object is, whose it was, why it is being let go — because a catalogue of
 * classified-ad lines would demonstrate the wrong product. Every story is
 * about the object actually in its photograph.
 *
 * Order is creation order and the feed sorts newest first, so the last entry
 * here is the first card on the table.
 */
export const CATALOGUE = [
  {
    key: "kettle",
    title: "Copper kettle that still whistles",
    story:
      "It lived on my mother's back burner for as long as I can remember, and it is the sound I associate with her kitchen more than any other. The base is scorched and the handle has been re-wrapped twice. It boils water perfectly well and I have an electric one now, which is the whole sad story.",
    category: "home_kitchen",
    postalCode: "02144",
    aspects: [
      { name: "object", value: "stovetop kettle" },
      { name: "material", value: "copper" },
      { name: "condition", value: "scorched base, re-wrapped handle" },
    ],
  },
  {
    key: "brooch",
    title: "Copper beetle brooch",
    story:
      "My aunt bought this in a market stall in the seventies and wore it on everything, including, once, a swimming costume, to make a point. I have kept it in a drawer for four years and a drawer is not where it belongs.",
    category: "jewelry_watches",
    postalCode: "02139",
    aspects: [
      { name: "object", value: "brooch" },
      { name: "material", value: "copper" },
      { name: "era", value: "1970s" },
    ],
  },
  {
    key: "letters",
    title: "Postcards, about two hundred of them",
    story:
      "Forty years of them, kept in the order they arrived, most from people saying very little at length. Half are seaside towns nobody photographs any more. I have read them all and would rather they went to someone who wants to read them than to a recycling bin.",
    category: "books_letters",
    postalCode: "01608",
    aspects: [
      { name: "object", value: "postcards" },
      { name: "quantity", value: "about two hundred" },
      { name: "era", value: "1950s-1990s" },
    ],
  },
  {
    key: "plane",
    title: "Hand plane, sharpened to half its blade",
    story:
      "My father's, and sharpened so often over so many years that the blade is half what it started as. He hung every door in our house with it. It still takes a clean shaving off pine. It should be on a bench, being used, not on my shelf being looked at.",
    category: "tools_diy",
    postalCode: "02144",
    aspects: [
      { name: "object", value: "hand plane" },
      { name: "material", value: "steel and wood" },
      { name: "condition", value: "sharp, blade half worn down" },
    ],
  },
  {
    key: "records",
    title: "A crate of LPs, sleeves and all",
    story:
      "Collected one payday at a time across the sixties. Three of the sleeves have given out at the seams and one has a coffee ring on it that has been there longer than I have owned a coffee table. Nothing in the house plays them any more.",
    category: "music_instruments",
    postalCode: "02139",
    aspects: [
      { name: "object", value: "vinyl LPs" },
      { name: "era", value: "1960s" },
      { name: "condition", value: "three sleeves split at the seams" },
    ],
  },
  {
    key: "quilt",
    title: "Patchwork quilt, double bed size",
    story:
      "Stitched by my grandmother the winter she retired, out of my grandfather's shirts, which is why it is mostly plaid. There is one square of a blue she must have run out of, and it stops abruptly halfway along the second row. Warm in a way nothing bought has ever been.",
    category: "photos_art_handmade",
    postalCode: "02144",
    aspects: [
      { name: "object", value: "patchwork quilt" },
      { name: "material", value: "cotton shirting" },
      { name: "size", value: "double bed" },
    ],
  },
  {
    key: "butterdish",
    title: "Cut-glass dish, no chips",
    story:
      "It held boiled sweets on my grandparents' hall table for thirty years and was never once allowed to hold anything else. No chips, no cracks, and the lid still sits properly. I would like it to be somewhere it gets used rather than a cupboard I open twice a year.",
    category: "home_kitchen",
    postalCode: "02144",
    aspects: [
      { name: "object", value: "lidded dish" },
      { name: "material", value: "cut glass" },
      { name: "condition", value: "no chips or cracks" },
    ],
  },
];

/**
 * Resolve a catalogue entry's two files and their measurements against a photo
 * directory, so a missing file is reported before anything is uploaded rather
 * than as a mystery 400 halfway through a run.
 *
 * `--photos <dir>` points this at a directory of your own; that directory must
 * carry a `manifest.json` of `{ "<key>": { width, height, blurhash } }`,
 * because those three numbers cannot be derived without decoding the image and
 * this tool deliberately has no image dependencies (see the runbook).
 */
export function loadPhotoSet(dir = DEFAULT_PHOTO_DIR) {
  const manifestPath = path.join(dir, "manifest.json");
  const measurements = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : PHOTOS;

  const photos = {};
  for (const [key, measurement] of Object.entries(measurements)) {
    const full = path.join(dir, `${key}.jpg`);
    const thumb = path.join(dir, `${key}.thumb.jpg`);
    photos[key] = { key, full, thumb, ...measurement };
  }
  return photos;
}

/** Everything wrong with a photo set, as a list, so one run reports all of it. */
export function photoSetProblems(catalogue, photos) {
  const problems = [];
  for (const listing of catalogue) {
    const photo = photos[listing.key];
    if (!photo) {
      problems.push(`${listing.key}: no photo named "${listing.key}" in the photo set`);
      continue;
    }
    if (!existsSync(photo.full)) problems.push(`${listing.key}: missing ${photo.full}`);
    if (!existsSync(photo.thumb)) problems.push(`${listing.key}: missing ${photo.thumb}`);
    if (!photo.width || !photo.height || !photo.blurhash) {
      problems.push(`${listing.key}: manifest entry needs width, height and blurhash`);
    }
  }
  return problems;
}
