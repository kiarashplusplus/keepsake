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
export const CATEGORIES = [
  "books_letters",
  "jewelry_watches",
  "home_kitchen",
  "photos_art_handmade",
  "other",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  books_letters: "Books & letters",
  jewelry_watches: "Jewelry & watches",
  home_kitchen: "Home & kitchen",
  photos_art_handmade: "Photos, art & handmade",
  other: "Other",
};

export const TITLE_MIN = 4;
export const TITLE_MAX = 80;
