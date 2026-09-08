/**
 * Drift guards, not unit tests of a pure function.
 *
 * Everything this file checks is a value copied from somewhere else in the
 * repo — a category enum, a title bound, a blurhash measured against bytes in
 * another package, a postcode the local harness seeds. A copy that stops
 * matching its source fails here, at `pnpm --filter "./tools/*" test`, instead
 * of as a 400 in the middle of a seeding run or, worse, as a card laid out to
 * the wrong aspect ratio.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATALOGUE,
  DEFAULT_PHOTO_DIR,
  PHOTOS,
  loadPhotoSet,
  photoSetProblems,
  REPO_ROOT,
} from "./catalogue.mjs";

const read = (...parts) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

/** `export const CATEGORIES = [...]` from the contracts package. */
function contractCategories() {
  const source = read("packages", "contracts", "src", "category.ts");
  const block = source.match(/export const CATEGORIES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "could not find CATEGORIES in packages/contracts/src/category.ts");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

function contractNumber(file, name) {
  const source = read("packages", "contracts", "src", file);
  const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
  assert.ok(match, `could not find ${name} in packages/contracts/src/${file}`);
  return Number(match[1]);
}

test("every catalogue category is one the contracts enum allows", () => {
  const allowed = new Set(contractCategories());
  for (const listing of CATALOGUE) {
    assert.ok(
      allowed.has(listing.category),
      `${listing.key}: category "${listing.category}" is not in CATEGORIES`,
    );
  }
});

test("titles and stories satisfy the bounds CreateListingInput enforces", () => {
  const titleMin = contractNumber("category.ts", "TITLE_MIN");
  const titleMax = contractNumber("category.ts", "TITLE_MAX");
  const storyMin = contractNumber("listing.ts", "STORY_MIN");
  const storyMax = contractNumber("listing.ts", "STORY_MAX");

  for (const listing of CATALOGUE) {
    const title = listing.title.trim();
    const story = listing.story.trim();
    assert.ok(
      title.length >= titleMin && title.length <= titleMax,
      `${listing.key}: title is ${title.length} chars`,
    );
    assert.ok(
      story.length >= storyMin && story.length <= storyMax,
      `${listing.key}: story is ${story.length} chars`,
    );
    // TitleSchema's own regex: titles are interpolated into email subject
    // headers, which are never escaped.
    assert.match(title, /^[^\x00-\x1f\x7f]*$/, `${listing.key}: title has a control character`);
  }
});

test("no listing carries contact details, which the API auto-rejects", () => {
  // `apps/api/src/moderation/contactInfo.ts` is the real gate (and it reads
  // aspects too, since #171). This is the cheap front door: a seeded listing
  // that trips it would be rejected mid-run for a reason the run cannot fix.
  for (const listing of CATALOGUE) {
    const text = `${listing.title} ${listing.story}`;
    assert.doesNotMatch(text, /[\w.]+@[\w.]+/, `${listing.key}: looks like an email address`);
    assert.doesNotMatch(text, /https?:\/\//i, `${listing.key}: looks like a URL`);
    assert.doesNotMatch(text, /\d[\d\s().-]{7,}\d/, `${listing.key}: looks like a phone number`);
  }
});

test("keys and titles are unique — the skip check keys on the title", () => {
  assert.equal(new Set(CATALOGUE.map((l) => l.key)).size, CATALOGUE.length);
  assert.equal(new Set(CATALOGUE.map((l) => l.title)).size, CATALOGUE.length);
});

test("postcodes are ones a local stack seeds, so --env local works unattended", () => {
  const setup = read("apps", "web", "e2e", "support", "global-setup.mjs");
  const block = setup.match(/const POSTAL_CODES = \[([\s\S]*?)\];/);
  assert.ok(block, "could not find POSTAL_CODES in e2e/support/global-setup.mjs");
  const seeded = new Set([...block[1].matchAll(/"US", "(\w+)"/g)].map((match) => match[1]));

  for (const listing of CATALOGUE) {
    assert.ok(
      seeded.has(listing.postalCode),
      `${listing.key}: ${listing.postalCode} is not seeded locally`,
    );
  }
});

test("the catalogue spans more than one postcode, including one outside 25 miles", () => {
  const codes = new Set(CATALOGUE.map((l) => l.postalCode));
  assert.ok(
    codes.size >= 2,
    "a seeded feed with one postcode gives the radius filter nothing to do",
  );
  assert.ok(
    codes.has("01608"),
    "01608 is the ~37-mile row; without it nothing falls outside the default radius",
  );
});

test("photo measurements match e2e/support/demoPhotos.ts, which measured the bytes", () => {
  // Matched a line at a time, not with a `{...}` regex: a blurhash may itself
  // contain `}` (kettle's does), which is exactly the kind of near-miss a
  // drift guard must not report as drift.
  const lines = read("apps", "web", "e2e", "support", "demoPhotos.ts").split("\n");
  for (const [key, photo] of Object.entries(PHOTOS)) {
    const line = lines.find((candidate) => candidate.trimStart().startsWith(`${key}: {`));
    assert.ok(line, `demoPhotos.ts no longer has a "${key}" entry`);
    assert.match(line, new RegExp(`width: ${photo.width}\\b`), `${key}: width drifted`);
    assert.match(line, new RegExp(`height: ${photo.height}\\b`), `${key}: height drifted`);
    assert.ok(line.includes(`blurhash: "${photo.blurhash}"`), `${key}: blurhash drifted`);
  }
});

test("every catalogue entry resolves to two files that exist", () => {
  const photos = loadPhotoSet();
  assert.deepEqual(photoSetProblems(CATALOGUE, photos), []);
  for (const listing of CATALOGUE) {
    assert.ok(existsSync(photos[listing.key].full));
    assert.ok(existsSync(photos[listing.key].thumb));
    assert.ok(photos[listing.key].full.startsWith(DEFAULT_PHOTO_DIR));
  }
});

test("photoSetProblems reports a missing file rather than letting the run find it", () => {
  const problems = photoSetProblems([{ key: "kettle" }, { key: "nosuchthing" }], {
    kettle: {
      key: "kettle",
      full: "/nope/kettle.jpg",
      thumb: "/nope/kettle.thumb.jpg",
      width: 1,
      height: 1,
      blurhash: "x",
    },
  });
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.includes("nosuchthing")));
  assert.ok(problems.some((p) => p.includes("/nope/kettle.jpg")));
});

test("loadPhotoSet reads manifest.json when the directory carries one — the --photos path", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "keepsake-seed-"));
  try {
    writeFileSync(
      path.join(tmp, "manifest.json"),
      JSON.stringify({ mug: { width: 10, height: 20, blurhash: "abcdef" } }),
    );
    const photos = loadPhotoSet(tmp);
    assert.deepEqual(Object.keys(photos), ["mug"]);
    assert.equal(photos.mug.width, 10);
    assert.equal(photos.mug.full, path.join(tmp, "mug.jpg"));
    assert.equal(photos.mug.thumb, path.join(tmp, "mug.thumb.jpg"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("curated aspects satisfy AspectSchema and MAX_ASPECTS", () => {
  const source = read("packages", "contracts", "src", "photo.ts");
  const max = Number(source.match(/export const MAX_ASPECTS = (\d+);/)[1]);
  const nameMax = Number(source.match(/name: z\.string\(\)\.trim\(\)\.min\(1\)\.max\((\d+)\)/)[1]);
  const valueMax = Number(
    source.match(/value: z\.string\(\)\.trim\(\)\.min\(1\)\.max\((\d+)\)/)[1],
  );

  for (const listing of CATALOGUE) {
    const aspects = listing.aspects ?? [];
    assert.ok(aspects.length > 0, `${listing.key}: seeded cards should carry aspects`);
    assert.ok(aspects.length <= max, `${listing.key}: ${aspects.length} aspects, max is ${max}`);
    for (const aspect of aspects) {
      assert.ok(
        aspect.name.length >= 1 && aspect.name.length <= nameMax,
        `${listing.key}: name "${aspect.name}"`,
      );
      assert.ok(
        aspect.value.length >= 1 && aspect.value.length <= valueMax,
        `${listing.key}: value "${aspect.value}"`,
      );
      // #171: aspects are checked for contact info exactly like the story is.
      assert.doesNotMatch(
        `${aspect.name} ${aspect.value}`,
        /[\w.]+@[\w.]+|https?:\/\//i,
        `${listing.key}: contact info`,
      );
    }
  }
});
