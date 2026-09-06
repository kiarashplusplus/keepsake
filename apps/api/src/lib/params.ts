import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * `c.req.param(name)` types as `string | undefined` whenever Hono can't
 * statically prove the path parameter exists from context — which happens
 * for every route in this app that runs through one of our own middleware
 * factories, since a middleware written as `(c: Context<{...}>, next) =>`
 * fixes Hono's path-string generic to its default rather than the actual
 * route pattern. At runtime the parameter always exists (Hono only invokes
 * the handler for a path that matched `/:id`), so this just narrows the type
 * without a bare `!`/`as` at every call site; if it's ever wrong, that's a
 * real routing bug worth a 500, not a silent `undefined` flowing into a SQL
 * bind.
 */
export function requireParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) {
    throw new HTTPException(500, { message: `Missing expected path param :${name}` });
  }
  return value;
}
