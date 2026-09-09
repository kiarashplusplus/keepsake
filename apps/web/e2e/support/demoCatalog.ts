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
 */
import type { APIRequestContext } from "@playwright/test";
import {
  createApprovedListing,
  hideListingAsAdmin,
  markListingGiven,
  ownerHeaders,
  rejectListingAsAdmin,
  reportListing,
  sendRequest,
} from "./api";
import { confirmDemoRequests, pinListingIds } from "./demoDb";
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
 * The keepsake that has already found a home — the item page's `Given` stamp
 * and the giver's own view of a closed listing.
 *
 * Kept out of `DEMO_LISTINGS` for the same reason the hidden one is: the
 * feed is `status = 'approved'` only (`apps/api/src/routes/feed.ts`), so a
 * given keepsake is never on the table, and folding it into the six would
 * mean every feed frame quietly showed five. `GET /api/listings/:id` still
 * answers for it, which is exactly the screen a stranger reaches from an old
 * link or a shared card after the giver has chosen someone.
 *
 * Marked given through `POST /api/listings/:id/given` — the same button the
 * dashboard has — rather than by writing the status into D1, so the
 * `given_at` timestamp, the closed requests and the owner row are all the
 * ones the real product would have produced.
 */
export const DEMO_GIVEN_LISTING: DemoListing = {
  key: "given",
  // Reuses the records photograph, the same way the hidden listing reuses
  // the give walkthrough's: a crate of shellac and a rack of sleeves are
  // near enough the same object to read right, and adding an eighth
  // photograph to `e2e/fixtures/photos` would cost 200 KB of repository for
  // one frame. The two do share `/mine`, where this is the only pair of
  // matching thumbnails — a household clearing out a record collection in
  // two goes, which is not a strange thing for this product to show.
  photo: DEMO_PHOTOS.records,
  title: "A crate of 78s",
  story:
    "Shellac, mostly dance bands, all of them my grandfather's and all of them too brittle to post. Somebody with a wind-up gramophone came for them last month, which is a better ending than I expected when I started clearing the house.",
  category: "music_instruments",
  postalCode: "02139",
};

/**
 * The keepsake three strangers reported, which the threshold then took off
 * the table by itself.
 *
 * Everything hidden in this fixture until now was hidden by an admin
 * (`DEMO_HIDDEN_LISTING`), so `report_count` was 0 on every card the queue
 * has ever been photographed with and `QueueItemCard`'s `Reports (n)` section
 * — the rows a moderator actually reads before deciding — has only ever been
 * in a frame saying "None.". This one is reported through the product's own
 * public route, three times from three addresses, so it carries three real
 * `reports` rows, the `report_autohide` moderation event, and the status the
 * threshold gave it rather than one an admin chose.
 *
 * Kept out of `DEMO_LISTINGS` for the same reason the other two are: it ends
 * up `hidden`, so it is never on the feed, and no existing frame changes
 * because it exists.
 */
export const DEMO_REPORTED_LISTING: DemoListing = {
  key: "reported",
  // Reuses the quilt photograph. Nothing about the picture is what got this
  // one reported — the point of the frame is the report rows and the
  // giver's side of a takedown, not a doctored photo — and an eighth file in
  // `e2e/fixtures/photos` would cost 200 KB of repository for one card.
  photo: DEMO_PHOTOS.quilt,
  title: "Bundle of woollen blankets",
  story:
    "Seeded by the UX baseline capture so the admin queue has one listing that reported itself off the table. Three strangers flagged it, which is what the threshold is counted in.",
  category: "home_kitchen",
  postalCode: "02139",
};

/**
 * The three reports that take `DEMO_REPORTED_LISTING` down — fixed reasons,
 * fixed words, one of them with no details at all, because a moderator's card
 * shows both shapes and the frame should too.
 *
 * `REPORT_AUTOHIDE_THRESHOLD` is three (`apps/api/src/env.ts`'s
 * `DEFAULT_REPORT_AUTOHIDE_THRESHOLD`, and nothing in this suite overrides
 * it), so this list being three long is the whole mechanism: two of these
 * would leave the listing live.
 */
export const DEMO_REPORTS = [
  { reason: "not_a_keepsake", details: "This looks like stock from a shop, not one household's own things." },
  { reason: "spam", details: "The same bundle is listed three times with different postcodes." },
  { reason: "other" },
] as const satisfies readonly { reason: string; details?: string }[];

/**
 * The keepsake a moderator rejected, and the only way to photograph what a
 * giver is told about it.
 *
 * `mine/[id].tsx`'s `statusDetailFor()` has exactly two branches that say
 * more than the eyebrow does, and a rejection is one of them: the sentence
 * under the status is `MODERATION_REASONS[reason]` — the giver-facing copy
 * #354 rewrote, which until now existed in the baseline only as chips in the
 * admin's own reject sheet. The story below carries a phone number so the
 * reason it is rejected for is the reason it would really be rejected for.
 */
export const DEMO_REJECTED_LISTING: DemoListing = {
  key: "rejected",
  photo: DEMO_PHOTOS.kettle,
  title: "Pair of enamel bread bins",
  story:
    "Both from my mother's pantry and both still sound. Ring me on 555-0134 and I will keep them by the door for you, or text the same number any evening this week.",
  category: "home_kitchen",
  postalCode: "02144",
};

/** The reason `DEMO_REJECTED_LISTING` is rejected with — an
 * `ADMIN_REJECT_REASONS` code, and the key into `MODERATION_REASONS` for the
 * sentence the giver reads. Matches the phone number in the story above. */
export const DEMO_REJECT_REASON = "contact_in_story";

/**
 * The live keepsake carrying one report short of the threshold.
 *
 * `StatsStrip`'s report-pressure section (issue #89) has two badges, and a
 * baseline where nothing has ever been reported photographs both at zero. The
 * red one is `DEMO_REPORTED_LISTING` above; this is the ink one — "One report
 * away" is a heads-up about a listing that is still on the table, so the
 * keepsake this names stays approved, stays on the feed, and no frame of the
 * feed changes because of it.
 */
export const NEAR_THRESHOLD_KEY = "records";

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

/**
 * Issue #225: fixed ids for every listing above, one per `DemoListing.key`.
 * The API always mints a fresh ULID on create, and `ListingCard` hashes that
 * id into the print's tilt and vertical offset (`tiltDegForId()` /
 * `verticalOffsetForId()`, `src/lib/masonry.ts`), so a re-seeded catalogue
 * landed at a new angle on every capture even though every word on the card
 * stayed the same — the churn `docs/qa/baseline/README.md` used to describe.
 * `ensureDemoCatalog()` rewrites each minted id to its entry here
 * (`./demoDb.ts`'s `pinListingIds()`) right after creating it, so the hash
 * input — and therefore the tilt and offset — is the same on every run.
 *
 * Valid `UlidSchema` shape (Crockford base32, 26 chars, no ambiguous
 * I/L/O/U) but never minted by `ulid()`: readable on purpose, so a listing
 * id in a log or a failed assertion is recognisably one of this fixture's
 * rather than a stray real one.
 */
export const PINNED_LISTING_IDS: Record<string, string> = {
  kettle: "SEEDCARD010000000000000000",
  brooch: "SEEDCARD020000000000000000",
  letters: "SEEDCARD030000000000000000",
  plane: "SEEDCARD040000000000000000",
  records: "SEEDCARD050000000000000000",
  quilt: "SEEDCARD060000000000000000",
  hidden: "SEEDCARD070000000000000000",
  given: "SEEDCARD080000000000000000",
  reported: "SEEDCARD090000000000000000",
  rejected: "SEEDCARD100000000000000000",
};

export interface DemoCatalog {
  ownerToken: string;
  /** `DemoListing.key` -> its pinned id (`PINNED_LISTING_IDS`) — what the
   * API minted, rewritten by `pinListingIds()` (issue #225). */
  ids: Record<string, string>;
  /** The listing this project may choose a requester on, by project name. */
  requestedIdFor: (projectName: string) => string;
  hiddenId: string;
  /** The keepsake that has already been given away (`DEMO_GIVEN_LISTING`). */
  givenId: string;
  /** The keepsake three reports took off the table (`DEMO_REPORTED_LISTING`). */
  reportedId: string;
  /** The keepsake a moderator rejected (`DEMO_REJECTED_LISTING`). */
  rejectedId: string;
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
  const all = [...DEMO_LISTINGS, DEMO_HIDDEN_LISTING, DEMO_GIVEN_LISTING, DEMO_REPORTED_LISTING, DEMO_REJECTED_LISTING];
  const existing = await existingCatalog(request);
  const complete = existing !== null && all.every((listing) => existing.has(listing.title));

  const ids: Record<string, string> = {};

  if (complete) {
    for (const listing of all) ids[listing.key] = existing.get(listing.title) as string;
  } else {
    const mintedToPinned: Record<string, string> = {};
    for (const listing of all) {
      const created = await createApprovedListing(request, {
        title: listing.title,
        story: listing.story,
        category: listing.category,
        postalCode: listing.postalCode,
        photo: listing.photo,
        ownerToken: DEMO_OWNER_TOKEN,
      });
      mintedToPinned[created.id] = PINNED_LISTING_IDS[listing.key] as string;
      ids[listing.key] = PINNED_LISTING_IDS[listing.key] as string;
    }

    // Issue #225. Every id above is still the one the real API minted —
    // this is the one place that stops being true, on purpose, so
    // `tiltDegForId()`/`verticalOffsetForId()` hash the same string on every
    // capture. Everything below references `ids[key]`, which already holds
    // the pinned value, so nothing downstream ever sees the minted one.
    pinListingIds(mintedToPinned);

    const requestIdToListingId: Record<string, string> = {};
    for (const key of Object.values(REQUESTED_KEYS_BY_PROJECT)) {
      for (const requester of DEMO_REQUESTS) {
        const sent = await sendRequest(request, ids[key] as string, requester);
        requestIdToListingId[sent.id] = ids[key] as string;
      }
    }
    // Issue #240. `sendRequest()` above only ever produces a *held*,
    // unconfirmed ask — #188 working as designed — so the giver's dashboard
    // cannot see either request yet. Confirm both directly, the same way the
    // pin above rewrote ids, rather than adding any way for a caller to
    // hand this (or any) route a confirmation token.
    confirmDemoRequests(requestIdToListingId);

    await hideListingAsAdmin(request, ids.hidden as string, "ux baseline fixture");
    await markListingGiven(request, ids.given as string, DEMO_OWNER_TOKEN);
    await rejectListingAsAdmin(request, ids.rejected as string, DEMO_REJECT_REASON);

    // The two report states, both produced by the public route rather than
    // by an admin: three reports take `reported` down on their own (the
    // threshold is three, so the third of these is the one that hides it),
    // and two leave `records` live and one away from the same fate. Only
    // this branch runs them — `ensureDemoCatalog()` is idempotent, and a
    // second project reporting `records` again would auto-hide the keepsake
    // the first project photographed on the feed.
    for (const report of DEMO_REPORTS) {
      await reportListing(request, ids.reported as string, report);
    }
    for (const report of DEMO_REPORTS.slice(0, 2)) {
      await reportListing(request, ids[NEAR_THRESHOLD_KEY] as string, report);
    }
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
    givenId: ids.given as string,
    reportedId: ids.reported as string,
    rejectedId: ids.rejected as string,
  };
}
