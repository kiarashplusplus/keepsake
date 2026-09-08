/**
 * `requireGrant()` — the second half of a bulk write's identity, after
 * `ownerAuth()`.
 *
 * The grant id named in `X-Bulk-Grant` is **not a secret**. Per the
 * migration's own comment on `bulk_grants` and `BULK_GRANT_HEADER`'s doc
 * comment in `@keepsake/contracts/bulk`: a grant only ever says *how much*
 * admission a caller holds, never *who* they are. `Authorization` still
 * carries the owner token, and it is checked first — `ownerAuth()` runs
 * ahead of this middleware on every bulk route that mounts both — so
 * knowing a grant id, on its own, buys a stranger nothing: `loadUsableGrant`
 * scopes the lookup to the authenticated owner, and a grant minted for
 * someone else answers exactly like one that does not exist. A leaked grant
 * id is worth nothing without the device token it is bound to.
 */
import type { Context, Next } from "hono";
import { BULK_GRANT_HEADER } from "@keepsake/contracts/bulk";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";
import { loadUsableGrant, type BulkGrantRow } from "../bulk/grants.js";
import type { OwnerRow } from "./ownerAuth.js";

export type GrantVariables = { grant: BulkGrantRow };
type GrantCtx = Context<{ Bindings: Env; Variables: { owner: OwnerRow } & GrantVariables }>;

export function requireGrant() {
  return async (c: GrantCtx, next: Next) => {
    const owner = c.get("owner");
    const grantId = c.req.header(BULK_GRANT_HEADER);
    if (!grantId) {
      return fail(
        c,
        "forbidden",
        "This estate upload needs an admission grant — ask whoever set up your pilot for one.",
        403,
      );
    }

    const grant = await loadUsableGrant(c.env, { grantId, ownerId: owner.id, now: Date.now() });
    if (!grant) {
      return fail(
        c,
        "forbidden",
        "That admission grant isn't usable — it may have expired, been revoked, or belong to someone else.",
        403,
      );
    }

    c.set("grant", grant);
    await next();
  };
}
