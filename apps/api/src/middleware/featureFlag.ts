/**
 * Gates a router behind a kill switch, and answers a disabled feature with
 * `not_found` — never `forbidden`. Estate bulk upload is off in every
 * environment except `preview` (see `bulkUploadEnabled`'s own comment in
 * `../env.js`), and a `403` would announce "there is a feature here you may
 * not use" to anyone who happens to probe `/api/bulk/batches`. A disabled
 * feature should look exactly like a route that was never added, the same
 * promise `robots.txt`/`X-Robots-Tag` make about `/admin` for a different
 * reason.
 */
import type { Context, Next } from "hono";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";

type FlagCtx = Context<{ Bindings: Env }>;

export function featureFlag(check: (env: Env) => boolean) {
  return async (c: FlagCtx, next: Next) => {
    if (!check(c.env)) {
      return fail(c, "not_found", "Not found.", 404);
    }
    await next();
  };
}
