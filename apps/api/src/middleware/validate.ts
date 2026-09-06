/**
 * Body/query validation at the edge, against the same `@keepsake/contracts`
 * zod schemas the web client types itself with. A failure is always
 * `bad_request` with the flattened zod issues attached — one shape, so the
 * client never has to special-case which endpoint failed to parse it.
 */
import type { Context, Next } from "hono";
import type { z } from "zod";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";

type BodyCtx<S extends z.ZodTypeAny> = Context<{ Bindings: Env; Variables: { validatedBody: z.infer<S> } }>;
type QueryCtx<S extends z.ZodTypeAny> = Context<{ Bindings: Env; Variables: { validatedQuery: z.infer<S> } }>;

export function validateBody<S extends z.ZodTypeAny>(schema: S) {
  return async (c: BodyCtx<S>, next: Next) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return fail(c, "bad_request", "Expected a JSON body.", 400);
    }

    const result = schema.safeParse(json);
    if (!result.success) {
      return fail(c, "bad_request", "That didn't look right.", 400, {
        issues: result.error.flatten() as unknown as Record<string, unknown>,
      });
    }

    c.set("validatedBody", result.data as z.infer<S>);
    await next();
  };
}

export function validateQuery<S extends z.ZodTypeAny>(schema: S) {
  return async (c: QueryCtx<S>, next: Next) => {
    const result = schema.safeParse(c.req.query());
    if (!result.success) {
      return fail(c, "bad_request", "That didn't look right.", 400, {
        issues: result.error.flatten() as unknown as Record<string, unknown>,
      });
    }

    c.set("validatedQuery", result.data as z.infer<S>);
    await next();
  };
}
