/**
 * `POST /api/requests/withdraw` — the no-account path for a requester to
 * remove their own note, email, and phone number. Reachable only with the
 * single-use token mailed as a link in `requestReceived`
 * (`src/email/templates/requestReceived.ts`), the "we passed your note
 * along" confirmation sent when the request was created
 * (`src/routes/listings.ts`'s `POST /:id/requests`).
 *
 * Per docs/legal-considerations.md's "Deleting your information" gap: a
 * requester never has a device token or a dashboard, so a signed link is the
 * only way back in — the same shape `POST /api/recover/:token` already uses
 * for an owner who lost their device.
 *
 * A request that was already `chosen` can still be withdrawn: the giver may
 * already have the requester's contact info (it was revealed to them and
 * mailed to them at choose time — see docs/design/email.md's "contact
 * reveal rule"), and that disclosure can't be recalled. Withdrawing here
 * only erases Keepsake's own stored copy and flips the request's status so
 * the owner's dashboard stops showing it as live — it is honest about what
 * it can and can't undo, not a promise to un-send an email that already
 * landed. See docs/design/identity.md's "Request withdrawal" section.
 */
import { Hono } from "hono";
import { RequestWithdrawInput, type RequestWithdrawResult } from "@keepsake/contracts/request";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { sha256Hex } from "../lib/digest.js";
import { validateBody } from "../middleware/validate.js";

type Vars = { validatedBody: RequestWithdrawInput };
export const requestWithdrawRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

interface WithdrawableRequestRow {
  id: string;
  listing_id: string;
}

requestWithdrawRoutes.post("/withdraw", validateBody(RequestWithdrawInput), async (c) => {
  const input = c.get("validatedBody");
  const tokenHash = await sha256Hex(input.token);

  const row = await c.env.DB.prepare(
    `SELECT id, listing_id FROM requests WHERE withdraw_token_hash = ? AND withdrawn_at IS NULL`,
  )
    .bind(tokenHash)
    .first<WithdrawableRequestRow>();

  // Same "don't distinguish reasons" posture as `POST /api/recover/:token`:
  // unknown token, already-used token, and a typo all look identical from
  // the outside, so a caller can't learn anything by probing.
  if (!row) {
    return fail(c, "unauthorized", "This link is invalid or has already been used.", 401);
  }

  const now = Date.now();
  // Spend the bearer token in the same statement that performs the erasure.
  // The SELECT above is only a lookup: two isolates can both complete it
  // before either reaches this write. Keeping `withdrawn_at IS NULL` in the
  // UPDATE makes this the compare-and-set, so exactly one caller can claim
  // the token and therefore exactly one caller may decrement request_count.
  // `RETURNING` distinguishes the winner from a no-op without another
  // read-then-write window.
  //
  // `ip_digest = NULL` alongside the three obvious columns, issue #169. It
  // was absent from this list, so the one control a requester has over their
  // own data left behind the hashed IP of the day they used the site —
  // permanently, since nothing else ever removed a `requests` row except the
  // giver deleting the whole listing. `orphanSweep` now clears it at 48 hours
  // for every row regardless; erasing it here as well is the honest reading
  // of a button labelled "remove my information", which should not leave
  // something behind for two days because a nightly job has not run yet.
  // `confirm_token_hash = NULL` joins the list for issue #188: the confirm
  // link and the withdraw link are mailed to the same address, so a live
  // confirm token on a withdrawn row would let whoever still has that first
  // email put the request back — reviving a note and an address this row was
  // just asked to forget. Nulling it also frees the row from
  // `requests_confirm_token`, which is a UNIQUE index.
  // The withdraw hash is erased too. Once spent it has no product purpose,
  // and retaining a bearer credential after its holder asked us to remove
  // their information would be needless storage even though it is hashed.
  const claimed = await c.env.DB.prepare(
    `UPDATE requests SET status = 'withdrawn', withdrawn_at = ?, note = NULL, email = NULL, phone = NULL, ip_digest = NULL,
                         confirm_token_hash = NULL, withdraw_token_hash = NULL
     WHERE id = ? AND withdrawn_at IS NULL AND withdraw_token_hash = ?
     RETURNING id`,
  )
    .bind(now, row.id, tokenHash)
    .first<{ id: string }>();

  if (!claimed) {
    return fail(c, "unauthorized", "This link is invalid or has already been used.", 401);
  }

  // Keep the listing's request_count honest: a withdrawn request is no
  // longer a live ask. Floored at 0 defensively — it should never go
  // negative (this row's own confirmation is the only increment, and the
  // compare-and-set above means this token can't be replayed), but the floor costs nothing and a negative count
  // displayed in a dashboard would be a worse bug than a clamp.
  await c.env.DB.prepare(
    "UPDATE listings SET request_count = MAX(request_count - 1, 0) WHERE id = ?",
  )
    .bind(row.listing_id)
    .run();

  const result: RequestWithdrawResult = {
    id: row.id,
    listing_id: row.listing_id,
    withdrawn_at: now,
  };
  return ok(c, result);
});
