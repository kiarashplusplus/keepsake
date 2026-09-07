import { z } from "zod";

/**
 * The five listing categories and the title-length bounds, pulled out of
 * `listing.ts` into their own dependency-free leaf module.
 *
 * Why: `listing.ts` imports `PublicPhoto` from `photo.ts`, and `photo.ts`'s
 * `PhotoSuggestionSchema` needs the *real* `CATEGORIES`/`TITLE_MIN`/
 * `TITLE_MAX` (not a duplicated copy that could drift) so a bad AI
 * suggestion can never produce a title or category the create-listing form
 * would reject. Importing those constants straight from `listing.ts` would
 * make the two files import each other — a circular import that is a
 * runtime footgun for ESM `const` bindings (whichever module starts
 * evaluating first hits the other's export before it's initialized). Both
 * `listing.ts` and `photo.ts` import from here instead, and `listing.ts`
 * re-exports these names so nothing outside the package sees the split.
 */
/**
 * Widened from five to eleven in issue #136. The five were
 * `books_letters`, `jewelry_watches`, `home_kitchen`,
 * `photos_art_handmade` and `other`, which made `other` the honest answer
 * for a fishing-line spool — and for most of what people actually give
 * away. The six added here are the ordinary shapes of a household's
 * unwanted objects, not a taxonomy anyone should try to complete.
 *
 * Cheap to add, and deliberately kept cheap to delete: `listings.category`
 * is plain `TEXT` with no `CHECK` constraint (`0001_init.sql`), so this
 * needs no migration, and nothing anywhere branches on a specific category
 * value. `photo.ts` records that `category` is slated to be dropped
 * entirely in favour of `aspects`; widening it is not a reversal of that,
 * just making the field honest for as long as it exists.
 *
 * Order matters — it is the order the feed's chips render in and the order
 * the vision prompt reads them. `other` stays last, where a reader looking
 * for a home for their object will reach it after everything specific has
 * failed.
 */
export const CATEGORIES = [
  "books_letters",
  "jewelry_watches",
  "clothing_accessories",
  "home_kitchen",
  "furniture_decor",
  "photos_art_handmade",
  "toys_games",
  "sports_outdoors",
  "tools_diy",
  "electronics",
  "music_instruments",
  "other",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  books_letters: "Books & letters",
  jewelry_watches: "Jewelry & watches",
  clothing_accessories: "Clothing & accessories",
  home_kitchen: "Home & kitchen",
  furniture_decor: "Furniture & decor",
  photos_art_handmade: "Photos, art & handmade",
  toys_games: "Toys & games",
  sports_outdoors: "Sport & outdoors",
  tools_diy: "Tools & DIY",
  electronics: "Electronics",
  music_instruments: "Music & instruments",
  other: "Other",
};

export const TITLE_MIN = 4;
export const TITLE_MAX = 80;
