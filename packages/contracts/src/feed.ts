import { z } from "zod";
import { CursorSchema, PaginationLimitSchema } from "./common";
import { CategorySchema } from "./listing";
import { CountrySchema } from "./geo";

export const RADIUS_OPTIONS = [10, 25, 50, 100] as const;
export type RadiusMi = (typeof RADIUS_OPTIONS)[number];

/**
 * `z.coerce.number()` first, then piped into the literal union — a bare
 * `z.union([z.literal(10), ...])` only ever accepts the JS `number` 10, but
 * `radius_mi` arrives as the query-string value `"10"` on every real HTTP
 * `GET /api/feed?radius_mi=10` request (query values are always strings).
 * Matches how `lat`/`lng`/`limit` below all coerce for the same reason.
 */
export const RadiusMiSchema = z.coerce
  .number()
  .pipe(z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]));

export const FeedQuery = z.object({
  cursor: CursorSchema.optional(),
  category: CategorySchema.optional(),
  q: z.string().trim().min(1).max(80).optional(),
  country: CountrySchema.optional(),
  postal: z.string().trim().min(1).max(16).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius_mi: RadiusMiSchema.optional(),
  limit: PaginationLimitSchema,
});
export type FeedQuery = z.infer<typeof FeedQuery>;

export type FeedPage<T> = {
  items: T[];
  next_cursor: string | null;
};

export function feedPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
