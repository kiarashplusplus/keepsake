/**
 * The fixed set of keepsakes the UX baseline captures are taken against.
 *
 * Every other spec in this suite calls `uniqueTitle()` on purpose: a random
 * suffix is what lets two specs run in parallel without colliding over one
 * shared row. A screenshot set needs the opposite property. "The feed" is
 * only a useful thing to compare against last month's feed if it holds the
 * same six keepsakes, in the same order, with the same words on the cards —
 * otherwise every capture differs from every other capture and the diff says
 * nothing about the design.
 *
 * So this seeds a deterministic catalogue: fixed titles, fixed stories, fixed
 * categories, a fixed owner token, and a fixed pair of requests on one of
 * them. It is still created through the real API for the reasons `api.ts`
 * gives — real photos in R2, real owner rows, a real moderation decision —
 * just with the randomness taken out.
 *
 * `ensureDemoCatalog()` is idempotent so both baseline projects (`ux-mobile`
 * and `ux-desktop`) can call it and the second one finds the first one's
 * work rather than seeding a second copy of everything into the same feed.
 * It is not race-free — two workers entering it at once would both seed —
 * which is why `pnpm e2e:ux` passes `--workers=1`. The alternative, a
 * Playwright `globalSetup`, would put the seeding somewhere a reader of this
 * spec would not think to look.
 *
 * Issue #225: "fixed titles, fixed stories" above used to stop short of
 * "fixed ids", and that gap rewrote 16 of the baseline's 76 committed JPEG
 * frames on every capture even when nothing about the product had changed.
 * `packages/tokens/src/tilt.ts` hashes a listing's *id* into its resting
 * card angle and vertical offset — deliberately: `Print.tsx` wants every
 * card to look hand-tossed onto the table rather than grid-aligned, and a
 * hash of something stable about the listing is what makes one listing's
 * tilt repeatable across renders instead of re-rolled on every paint. But
 * this file wipes and reseeds through the real API on every run (that's the
 * whole point — see the header above), so the API mints a fresh ULID per
 * listing per run, and a fresh id is a fresh angle. The six screens that
 * render a list of prints — `feed-cards`, `feed-category`, `feed`, `mine`,
 * `mine-detail-*`, `admin-hidden`, and the dark set of each — moved on every
 * capture for a reason that had nothing to do with the design. (The item
 * page never moved: `PhotoCarousel` is handed a literal `tiltDeg`, not the
 * id-hashing path.)
 *
 * `DEMO_LISTING_IDS` below is the fix: after every listing in this file is
 * created through the real API exactly as before, `ensureDemoCatalog()`
 * renames each one to a fixed id via `reassignListingIds()`
 * (`POST /api/admin/testing/reassign-listing-ids`) — carrying `photos`,
 * `listing_aspects`, `requests`, `reports` and `moderation_events` along in
 * one D1 transaction (see that route's own comment in
 * `apps/api/src/routes/admin.ts` for the full mechanism, including why
 * `listings_fts` needs no such handling). This is a real exception to
 * `api.ts`'s "test data is created through the real API, never by writing
 * rows into D1" rule, and it is worth being explicit about why it's the
 * *only* exception in this suite rather than a precedent for others:
 *
 *  - Every other fixture in this suite calls `uniqueTitle()` /
 *    `mintOwnerToken()` and gets a fresh row from the API on every call,
 *    specifically so two specs running in parallel — or the same spec
 *    re-run against a `reuseExistingServer` server — can never collide over
 *    one shared row. Pinning an id there would recreate exactly the
 *    collision the randomness exists to prevent.
 *  - This fixture already *is* the named exception to that rule, before
 *    this change: `ensureDemoCatalog()` looks its listings up by title and
 *    reuses them across runs rather than minting new ones, precisely
 *    because the baseline wants one shared, recognizable catalogue, not a
 *    fresh one per call. A fixed id is the same deliberate choice applied
 *    one column over — it doesn't create a new kind of sharing, it just
 *    stops one part of an already-shared row (the id) from being the one
 *    thing left to chance.
 *  - The row itself is still exactly as real as it was: created through
 *    `POST /api/photos` and `POST /api/listings` like any other listing,
 *    with a genuine photo in R2, a genuine `owners` row, and a genuine
 *    `MOCK_AI` moderation decision behind it. Only the primary key is
 *    normalized afterward — nothing about *how* the row was produced
 *    changes, which is the property `api.ts`'s rule actually protects.
 */
import type { APIRequestContext } from "@playwright/test";
import { createApprovedListing, hideListingAsAdmin, ownerHeaders, reassignListingIds, sendRequest } from "./api";
import { DEMO_PHOTOS, type DemoPhoto } from "./demoPhotos";

/** `OwnerTokenSchema` wants `ks_` + exactly 43 base64url characters; the
 * padding keeps that true without anyone having to count by hand. */
const DEMO_OWNER_SUFFIX = "uxbaselinegiver".padEnd(43, "0");
export const DEMO_OWNER_TOKEN = `ks_${DEMO_OWNER_SUFFIX}`;

export interface DemoListing {
  key: string;
  /** The photograph this keepsake is seeded with. Fixed like everything else
   * here: a card whose image changed between runs would make the same feed
   * unrecognisable from one capture to the next. */
  photo: DemoPhoto;
  title: string;
  story: string;
  category: string;
  postalCode: string;
}

/**
 * Six keepsakes, written to exercise the layout rather than to fill it:
 * a short title next to a long one, a two-line story next to a five-line one,
 * two postcodes 1.7 miles apart and one 37 miles away (the distances
 * `global-setup.mjs` seeds real GeoNames centroids for, so the radius filter
 * has something to actually do).
 *
 * Order is creation order, and the feed sorts newest first — so the last
 * entry here is the first card on the table.
 */
export const DEMO_LISTINGS: DemoListing[] = [
  {
    key: "kettle",
    photo: DEMO_PHOTOS.kettle,
    title: "Copper kettle, 1954",
    story:
      "My grandmother boiled water in this every morning for fifty-one years, first in Somerville and then in the little kitchen she moved to after my grandfather died. The whistle is still loud enough to hear from the porch. It has a dent in one side from the day my brother knocked it off the stove, and she never once considered replacing it.",
    category: "home_kitchen",
    postalCode: "02144",
  },
  {
    key: "brooch",
    photo: DEMO_PHOTOS.brooch,
    title: "Enamel swallow brooch",
    story:
      "My mother wore this on the lapel of a grey winter coat every day of the sixteen years I lived at home. I have no coat it suits, and it should be on someone's shoulder rather than in a drawer of mine.",
    category: "jewelry_watches",
    postalCode: "02139",
  },
  {
    key: "letters",
    photo: DEMO_PHOTOS.letters,
    title: "A shoebox of postcards from the 1970s",
    story:
      "Two hundred or so, most of them to the same address in Worcester, most of them from people telling my aunt the weather was better where they were. The handwriting alone is worth an afternoon. I kept four and would like the rest to go to someone who reads them.",
    category: "books_letters",
    postalCode: "01608",
  },
  {
    key: "plane",
    photo: DEMO_PHOTOS.plane,
    title: "Stanley block plane",
    story:
      "Sharpened so many times the blade is half the length it started at. My father used it to hang every door in the house I grew up in. It wants a workbench, not a shelf.",
    category: "tools_diy",
    postalCode: "02144",
  },
  {
    key: "records",
    photo: DEMO_PHOTOS.records,
    title: "Twelve jazz records",
    story:
      "Bought one at a time between 1961 and 1968, played until three of the sleeves gave out. I have nothing left to play them on and they deserve better than being sold by weight.",
    category: "music_instruments",
    postalCode: "02139",
  },
  {
    key: "quilt",
    photo: DEMO_PHOTOS.quilt,
    title: "Hand-stitched quilt",
    story:
      "Made from my grandfather's shirts the winter after he retired, which is to say it is made mostly of plaid. Big enough for a double bed. Warm in a way nothing bought is.",
    category: "photos_art_handmade",
    postalCode: "02144",
  },
];

/** The listing the admin queue's Hidden tab is captured against — hidden
 * through the admin API rather than by three reporters, same reasoning as
 * `admin.spec.ts`. It never appears on the feed, so it is kept out of
 * `DEMO_LISTINGS` and seeded separately. */
export const DEMO_HIDDEN_LISTING: DemoListing = {
  key: "hidden",
  // Reuses the give walkthrough's photograph. The two never share a screen —
  // this one is admin-only and that one is deleted by the test that posts it —
  // and a dinner service is near enough a covered glass dish to read right.
  photo: DEMO_PHOTOS.butterdish,
  title: "Boxed dinner service (reported)",
  story:
    "Seeded by the UX baseline capture so the admin queue's Hidden tab has something in it. Hidden through the admin API, not by three reporters.",
  category: "home_kitchen",
  postalCode: "02144",
};

/**
 * `DemoListing.key` -> the fixed id every row is renamed to after creation
 * (see the header comment above for why). Deliberately far from anything a
 * real ULID could be: `apps/api/src/lib/ids.ts` encodes the current Unix
 * millisecond into the first ten characters and sixteen characters of real
 * randomness into the rest, so a string of twenty zeros followed by a
 * six-digit counter can never collide with one and reads, to anyone looking
 * straight at a database row, as obviously placed there rather than minted.
 * The counter is unrelated to creation order — it only has to be unique per
 * key, and is assigned in `DEMO_LISTINGS`/`DEMO_HIDDEN_LISTING` order purely
 * so the mapping below is easy to eyeball against those two definitions.
 */
export const DEMO_LISTING_IDS: Record<string, string> = {
  kettle: "00000000000000000000000001",
  brooch: "00000000000000000000000002",
  letters: "00000000000000000000000003",
  plane: "00000000000000000000000004",
  records: "00000000000000000000000005",
  quilt: "00000000000000000000000006",
  hidden: "00000000000000000000000007",
};

/** The two strangers whose notes sit under `/mine/:id`. Fixed addresses:
 * the giver's screen shows them masked until Choose, and a random address
 * would change the width of the masked line from one capture to the next. */
export const DEMO_REQUESTS = [
  {
    email: "hannah.q@keepsake.ing",
    note: "My mother had one exactly like this and I have been looking for years. I am ten minutes away and can collect any evening this week.",
  },
  {
    email: "peter.v@keepsake.ing",
    note: "I would give it to my daughter, who has just moved into her first flat and owns nothing older than she is.",
  },
];

/**
 * The keepsakes `DEMO_REQUESTS` are sent to — one per baseline project.
 *
 * Choosing a requester is a one-way door, and both projects run against one
 * database, so a single requested listing would leave whichever project ran
 * second capturing an already-chosen screen under a frame named `-requests`.
 * Two listings, one each, and both sets are honest.
 */
export const REQUESTED_KEYS_BY_PROJECT: Record<string, string> = {
  "ux-mobile": "kettle",
  "ux-desktop": "quilt",
};

export interface DemoCatalog {
  ownerToken: string;
  /** `DemoListing.key` -> the id the API minted. */
  ids: Record<string, string>;
  /** The listing this project may choose a requester on, by project name. */
  requestedIdFor: (projectName: string) => string;
  hiddenId: string;
}

interface OwnerListing {
  id: string;
  title: string;
}

async function existingCatalog(request: APIRequestContext): Promise<Map<string, string> | null> {
  const response = await request.get("/api/me/listings", {
    headers: ownerHeaders(DEMO_OWNER_TOKEN),
  });
  // 401 is the honest "this device has never given anything" answer for a
  // token the server has not seen — i.e. a run against a freshly wiped D1.
  if (!response.ok()) return null;
  const body = (await response.json()) as { ok: boolean; data?: OwnerListing[] };
  if (!body.ok || !body.data) return null;
  return new Map(body.data.map((listing) => [listing.title, listing.id]));
}

/**
 * Seed the catalogue if this run has not seeded it yet, and hand back the ids
 * either way.
 */
export async function ensureDemoCatalog(request: APIRequestContext): Promise<DemoCatalog> {
  const all = [...DEMO_LISTINGS, DEMO_HIDDEN_LISTING];
  const existing = await existingCatalog(request);
  const complete = existing !== null && all.every((listing) => existing.has(listing.title));

  const ids: Record<string, string> = {};

  if (complete) {
    // Every row here was already renamed to its `DEMO_LISTING_IDS` entry the
    // first time this ran — `existingCatalog()` looks rows up by title, so
    // it hands back whatever id the row holds *now*, which by this point is
    // always the fixed one. Nothing below re-touches D1: the idempotent path
    // is exactly this branch doing nothing but reading. The check against
    // `DEMO_LISTING_IDS` isn't load-bearing for the seed to work — it's a
    // tripwire, so a person who edits the id map without wiping the local
    // database gets a thrown error naming the mismatch instead of a
    // baseline that silently drifts back to unstable ids.
    for (const listing of all) {
      const id = existing.get(listing.title) as string;
      const expected = DEMO_LISTING_IDS[listing.key];
      if (expected && id !== expected) {
        throw new Error(
          `demoCatalog: "${listing.title}" is ${id} in D1 but DEMO_LISTING_IDS["${listing.key}"] is ${expected}. ` +
            "Wipe the e2e --persist-to state and reseed, or the two will never agree.",
        );
      }
      ids[listing.key] = id;
    }
  } else {
    for (const listing of all) {
      const created = await createApprovedListing(request, {
        title: listing.title,
        story: listing.story,
        category: listing.category,
        postalCode: listing.postalCode,
        photo: listing.photo,
        ownerToken: DEMO_OWNER_TOKEN,
      });
      ids[listing.key] = created.id;
    }

    // The rename happens once, for every listing at once, in a single call
    // — one D1 transaction rather than seven, and one place where a partial
    // failure (say, a bad pair) can't leave some listings renamed and
    // others not. Everything from here on (`sendRequest`, `hideListingAsAdmin`)
    // addresses listings by their now-final fixed id, so their own rows
    // (`requests`, the admin `moderation_events` entry) are written against
    // the id the baseline actually captures against — no second rename ever
    // has to chase them down.
    await reassignListingIds(
      request,
      all.map((listing) => ({ from: ids[listing.key] as string, to: DEMO_LISTING_IDS[listing.key] as string })),
    );
    for (const listing of all) ids[listing.key] = DEMO_LISTING_IDS[listing.key] as string;

    for (const key of Object.values(REQUESTED_KEYS_BY_PROJECT)) {
      for (const requester of DEMO_REQUESTS) {
        await sendRequest(request, ids[key] as string, requester);
      }
    }

    await hideListingAsAdmin(request, ids.hidden as string, "ux baseline fixture");
  }

  return {
    ownerToken: DEMO_OWNER_TOKEN,
    ids,
    requestedIdFor: (projectName) => {
      const key = REQUESTED_KEYS_BY_PROJECT[projectName];
      if (!key)
        throw new Error(
          `no requested listing is reserved for project "${projectName}" — add one to REQUESTED_KEYS_BY_PROJECT`,
        );
      return ids[key] as string;
    },
    hiddenId: ids.hidden as string,
  };
}
