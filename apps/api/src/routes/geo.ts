import { Hono } from "hono";
import { z } from "zod";
import { CountrySchema } from "@keepsake/contracts/geo";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { validateQuery } from "../middleware/validate.js";
import { burst } from "../middleware/rateLimit.js";
import { lookupPostalCode } from "../geo/lookup.js";

const GeoLookupQuery = z.object({
  country: CountrySchema,
  code: z.string().trim().min(1).max(16),
});

export const geoRoutes = new Hono<{ Bindings: Env; Variables: { validatedQuery: z.infer<typeof GeoLookupQuery> } }>();

geoRoutes.get("/lookup", burst("RL_READ"), validateQuery(GeoLookupQuery), async (c) => {
  const { country, code } = c.get("validatedQuery");
  const result = await lookupPostalCode(c.env, country, code);
  if (!result) {
    return fail(c, "not_found", "We don't know that postcode yet.", 404);
  }
  return ok(c, result);
});
