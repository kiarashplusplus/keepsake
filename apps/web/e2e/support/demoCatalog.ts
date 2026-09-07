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
import { createApprovedListing, hideListingAsAdmin, ownerHeaders, sendRequest } from "./api";

/** `OwnerTokenSchema` wants `ks_` + exactly 43 base64url characters; the
 * padding keeps that true without anyone having to count by hand. */
const DEMO_OWNER_SUFFIX = "uxbaselinegiver".padEnd(43, "0");
export const DEMO_OWNER_TOKEN = `ks_${DEMO_OWNER_SUFFIX}`;

export interface DemoListing {
  key: string;
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
    title: "Copper kettle, 1954",
    story:
      "My grandmother boiled water in this every morning for fifty-one years, first in Somerville and then in the little kitchen she moved to after my grandfather died. The whistle is still loud enough to hear from the porch. It has a dent in one side from the day my brother knocked it off the stove, and she never once considered replacing it.",
    category: "home_kitchen",
    postalCode: "02144",
  },
  {
    key: "brooch",
    title: "Enamel swallow brooch",
    story:
      "My mother wore this on the lapel of a grey winter coat every day of the sixteen years I lived at home. I have no coat it suits, and it should be on someone's shoulder rather than in a drawer of mine.",
    category: "jewelry_watches",
    postalCode: "02139",
  },
  {
    key: "letters",
    title: "A shoebox of postcards from the 1970s",
    story:
      "Two hundred or so, most of them to the same address in Worcester, most of them from people telling my aunt the weather was better where they were. The handwriting alone is worth an afternoon. I kept four and would like the rest to go to someone who reads them.",
    category: "books_letters",
    postalCode: "01608",
  },
  {
    key: "plane",
    title: "Stanley block plane",
    story:
      "Sharpened so many times the blade is half the length it started at. My father used it to hang every door in the house I grew up in. It wants a workbench, not a shelf.",
    category: "tools_diy",
    postalCode: "02144",
  },
  {
    key: "records",
    title: "Twelve jazz records",
    story:
      "Bought one at a time between 1961 and 1968, played until three of the sleeves gave out. I have nothing left to play them on and they deserve better than being sold by weight.",
    category: "music_instruments",
    postalCode: "02139",
  },
  {
    key: "quilt",
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
  title: "Boxed dinner service (reported)",
  story:
    "Seeded by the UX baseline capture so the admin queue's Hidden tab has something in it. Hidden through the admin API, not by three reporters.",
  category: "home_kitchen",
  postalCode: "02144",
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
    for (const listing of all) ids[listing.key] = existing.get(listing.title) as string;
  } else {
    for (const listing of all) {
      const created = await createApprovedListing(request, {
        title: listing.title,
        story: listing.story,
        category: listing.category,
        postalCode: listing.postalCode,
        ownerToken: DEMO_OWNER_TOKEN,
      });
      ids[listing.key] = created.id;
    }

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
