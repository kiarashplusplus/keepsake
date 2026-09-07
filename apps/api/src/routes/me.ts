import { Hono } from "hono";
import { SetEmailInput, type OwnerMe } from "@keepsake/contracts/owner";
import type { ModerationReasonCode } from "@keepsake/contracts/listing";
import {
  ADMIN_REMOVED_REQUEST_PLACEHOLDER,
  ChooseRequestInput,
  maskEmail,
  maskPhone,
  WITHDRAWN_REQUEST_PLACEHOLDER,
  type OwnerViewRequest,
} from "@keepsake/contracts/request";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { turnstile } from "../middleware/turnstile.js";
import { burst, dailyBudget, DEFAULT_EMAIL_IP_DAILY_BUDGET } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { serializeOwnerListing } from "../lib/serialize.js";
import { fetchAspectRows, fetchAspectRowsForListings, fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
import type { ListingRow } from "../lib/serialize.js";
import { requireParam } from "../lib/params.js";
import { ulid } from "../lib/ids.js";
import { sha256Hex } from "../lib/digest.js";
import { randomTokenRaw } from "../lib/tokens.js";
import { sendMail } from "../email/sendMail.js";
import { verifyEmail } from "../email/templates/verifyEmail.js";
import { chosen as chosenTemplate } from "../email/templates/chosen.js";

type Vars = { owner: OwnerRow; validatedBody: unknown };
export const meRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

interface RequestRow {
  id: string;
  // Nullable since `POST /api/requests/withdraw` erases both once a
  // requester withdraws — see docs/design/identity.md's "Request
  // withdrawal" section and migration 0005_compliance.sql.
  note: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: number;
  // NULL means the notification email relevant to this request's current
  // status was delivered (or none has been attempted yet); non-NULL is
  // `sendMail()`'s own reason — see migration 0008_notify_failed.sql and
  // `OwnerViewRequest.notify_failed`'s doc comment in
  // `@keepsake/contracts/request`.
  notify_failed_reason: string | null;
}

function serializeOwnerViewRequest(row: RequestRow): OwnerViewRequest {
  if (row.status === "withdrawn" || row.status === "removed" || row.email === null) {
    // Withdrawn: the requester exercised their own erasure link. Removed: an
    // admin redacted this request (POST /api/admin/requests/:id/remove, see
    // docs/runbooks/admin.md's minor-takedown rule) — the two must not
    // collapse into one message, since attributing an admin's action to the
    // requester would be a false statement to the giver, not a UI nicety.
    // Either way there is nothing left to mask — an empty `email_masked`
    // would read as a bug, not a choice, so this says plainly what happened.
    const isAdminRemoved = row.status === "removed";
    return {
      id: row.id,
      note: isAdminRemoved ? ADMIN_REMOVED_REQUEST_PLACEHOLDER : WITHDRAWN_REQUEST_PLACEHOLDER,
      created_at: row.created_at,
      status: isAdminRemoved ? "removed" : "withdrawn",
      email_masked: isAdminRemoved ? ADMIN_REMOVED_REQUEST_PLACEHOLDER : WITHDRAWN_REQUEST_PLACEHOLDER,
      notify_failed: false,
    };
  }

  const revealed = row.status === "chosen";
  return {
    id: row.id,
    note: row.note ?? "",
    created_at: row.created_at,
    status: row.status as OwnerViewRequest["status"],
    email_masked: maskEmail(row.email),
    ...(row.phone !== null ? { phone_masked: maskPhone(row.phone) } : {}),
    ...(revealed ? { email: row.email } : {}),
    ...(revealed && row.phone !== null ? { phone: row.phone } : {}),
    notify_failed: row.notify_failed_reason !== null,
  };
}

const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Every route that answers with the owner's identity builds it here.
 *
 * `POST /email` and `DELETE /email` used to return their own ad-hoc shapes
 * (`{ email, email_verified }` and `{ id }`), while the web client parses all
 * three with `OwnerMe`. The parse threw on the missing fields, so adding an
 * email showed "That didn't go through" even though the address had been saved
 * and the verification mail sent. Found by the Playwright suite.
 */
function ownerMe(owner: OwnerRow, overrides: Partial<OwnerMe> = {}): OwnerMe {
  return {
    id: owner.id,
    ...(owner.email !== null ? { email: owner.email } : {}),
    email_verified: owner.email_verified_at !== null,
    banned: owner.banned_at !== null,
    ...overrides,
  };
}

meRoutes.get("/", ownerAuth(), (c) => {
  return ok(c, ownerMe(c.get("owner")));
});

meRoutes.get("/listings", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
            status, moderation_reason, version, report_count, request_count, chosen_request_id,
            created_at, updated_at, published_at, given_at
     FROM listings WHERE owner_id = ? ORDER BY created_at DESC`,
  )
    .bind(owner.id)
    .all<ListingRow>();

  const aspectsByListing = await fetchAspectRowsForListings(
    c.env,
    rows.map((row) => row.id),
  );
  const items = [];
  for (const row of rows) {
    const photos = await fetchPhotoRows(c.env, row.id);
    items.push(serializeOwnerListing(row, photos, aspectsByListing.get(row.id) ?? []));
  }
  return ok(c, items);
});

meRoutes.get("/listings/:id", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) {
    return fail(c, "not_found", "Listing not found.", 404);
  }
  const photos = await fetchPhotoRows(c.env, id);
  const aspects = await fetchAspectRows(c.env, id);
  const ownerListing = serializeOwnerListing(row, photos, aspects);

  const { results: requestRows } = await c.env.DB.prepare(
    "SELECT id, note, email, phone, status, created_at, notify_failed_reason FROM requests WHERE listing_id = ? ORDER BY created_at",
  )
    .bind(id)
    .all<RequestRow>();

  return ok(c, {
    ...ownerListing,
    requests: requestRows.map(serializeOwnerViewRequest),
    moderation: {
      status: row.status,
      reason: (row.moderation_reason as ModerationReasonCode | null) ?? null,
      held: row.status === "needs_review",
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/me/listings/:id/choose
// ---------------------------------------------------------------------------
meRoutes.post("/listings/:id/choose", ownerAuth(), validateBody(ChooseRequestInput), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as ChooseRequestInput;

  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) {
    return fail(c, "not_found", "Listing not found.", 404);
  }

  const request = await c.env.DB.prepare(
    "SELECT id, listing_id, note, email, phone, status, created_at, notify_failed_reason FROM requests WHERE id = ?",
  )
    .bind(input.request_id)
    .first<RequestRow & { listing_id: string }>();

  if (!request || request.listing_id !== id) {
    return fail(c, "not_found", "Request not found.", 404);
  }
  if (request.status !== "open") {
    return fail(c, "conflict", "This request has already been decided.", 409);
  }
  // `status === "open"` guarantees `email` was never erased — only
  // `POST /api/requests/withdraw` nulls it, and that also flips status to
  // `withdrawn` — but the column is nullable at the type level since the
  // withdrawal migration, so this narrows it back for everything below.
  if (request.email === null) {
    return fail(c, "internal", "This request is missing its contact info.", 500);
  }
  const requestEmail = request.email;

  const now = Date.now();
  await c.env.DB.prepare("UPDATE requests SET status = 'chosen', chosen_at = ? WHERE id = ?").bind(now, request.id).run();
  await c.env.DB.prepare("UPDATE requests SET status = 'not_chosen' WHERE listing_id = ? AND id != ? AND status = 'open'")
    .bind(id, request.id)
    .run();
  await c.env.DB.prepare("UPDATE listings SET chosen_request_id = ?, updated_at = ? WHERE id = ?").bind(request.id, now, id).run();

  const giverVerified = owner.email !== null && owner.email_verified_at !== null;
  const itemLink = `${c.env.SITE_URL}/item/${id}`;
  const template = chosenTemplate({
    listingTitle: row.title,
    ...(giverVerified ? { giverEmail: owner.email as string } : {}),
    handoffNote: input.handoff_note,
    itemLink,
  });
  const sendResult = await sendMail(c.env, {
    kind: "chosen",
    to: requestEmail,
    ...(giverVerified ? { replyTo: owner.email as string } : {}),
    ...template,
  });

  // Issue #6: this used to be fire-and-forget, same as the owner-notify on
  // creation — a rejected recipient here means the person the giver just
  // picked never hears about it, while the giver's own screen says it
  // worked. Whatever `notify_failed_reason` this request carried from its
  // creation-time owner-notify no longer means anything once chosen — the
  // giver clearly already knows about the request, since they're the one
  // choosing it — so this overwrites it with the outcome of the send that
  // now actually matters.
  await c.env.DB.prepare("UPDATE requests SET notify_failed_reason = ? WHERE id = ?")
    .bind(sendResult.sent ? null : sendResult.reason ?? "send_failed", request.id)
    .run();

  const revealed: OwnerViewRequest = {
    id: request.id,
    note: request.note ?? "",
    created_at: request.created_at,
    status: "chosen",
    email_masked: maskEmail(requestEmail),
    ...(request.phone !== null ? { phone_masked: maskPhone(request.phone) } : {}),
    email: requestEmail,
    ...(request.phone !== null ? { phone: request.phone } : {}),
    notify_failed: !sendResult.sent,
  };
  return ok(c, revealed);
});

// ---------------------------------------------------------------------------
// POST/DELETE /api/me/email, GET /api/me/email/verify
// ---------------------------------------------------------------------------
// Issue #92: the `email` daily budget is the hard ceiling behind the burst
// brake, shared with `POST /api/recover` (see that route's comment) so a
// caller can't have the allowance twice by alternating between the two
// mail-sending routes. Worth knowing: the early return below — resubmitting
// an address you already confirmed, which sends nothing — still spends one
// unit. The ceiling is sized so that costs a real person nothing, and making
// it conditional would mean deciding whether to charge *after* running the
// handler, which is a different and much easier thing to get wrong.
meRoutes.post(
  "/email",
  ownerAuth(),
  turnstile(),
  burst("RL_EMAIL"),
  dailyBudget({ kind: "email", ipDailyLimitVar: "EMAIL_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_EMAIL_IP_DAILY_BUDGET }),
  validateBody(SetEmailInput),
  async (c) => {
    const owner = c.get("owner");
    const input = c.get("validatedBody") as import("@keepsake/contracts/owner").SetEmailInput;
    const now = Date.now();

    // Re-submitting the address you already confirmed is a no-op, not a reset.
    // Otherwise a double-tap on "Save", or re-opening the form and pressing it
    // again, silently drops you back to unverified and mails you another link —
    // which is exactly what happened during preview testing.
    if (owner.email === input.email && owner.email_verified_at !== null) {
      return ok(c, ownerMe(owner));
    }

    await c.env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = NULL WHERE id = ?").bind(input.email, owner.id).run();

    // Issue #167: the address just changed, so every link already sitting in
    // an inbox was mailed to a *different* address and must stop working.
    // This is the write-side half; `GET /email/verify` carries the read-side
    // half, which is what covers tokens minted by routes that don't run this.
    await invalidateOutstandingVerifyTokens(c.env, owner.id, now);

    const rawToken = randomTokenRaw();
    const tokenHash = await sha256Hex(rawToken);
    await c.env.DB.prepare(
      `INSERT INTO recovery_tokens (id, owner_id, purpose, email, token_hash, expires_at, created_at)
       VALUES (?, ?, 'verify_email', ?, ?, ?, ?)`,
    )
      .bind(ulid(), owner.id, input.email, tokenHash, now + VERIFY_EMAIL_TTL_MS, now)
      .run();

    const verifyUrl = `${c.env.SITE_URL}/api/me/email/verify?token=${rawToken}`;
    await sendMail(c.env, { kind: "verify_email", to: input.email, ...verifyEmail({ link: verifyUrl }) });

    return ok(c, ownerMe(owner, { email: input.email, email_verified: false }));
  },
);

meRoutes.delete("/email", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  await c.env.DB.prepare("UPDATE owners SET email = NULL, email_verified_at = NULL WHERE id = ?").bind(owner.id).run();
  // Issue #167: same reasoning as `POST /email` — an address that has been
  // removed cannot be confirmed later by a link that was mailed before it
  // went away.
  await invalidateOutstandingVerifyTokens(c.env, owner.id, Date.now());
  // Email cleared: report it gone rather than echoing the stale row.
  const { email: _removed, ...cleared } = ownerMe(owner);
  return ok(c, { ...cleared, email_verified: false });
});

// Not `ownerAuth()`-guarded: this is a link clicked from an email, not an
// API call carrying the owner's bearer token — the single-use recovery
// token in the query string *is* the credential here.
//
// Issue #167: this used to stamp `email_verified_at` on the owner row and
// nothing else, so the token's only subject was the *owner*. Clicking any
// unexpired link marked whatever address happened to be on the row at click
// time as verified — including one nobody had ever confirmed. Reachable by
// ordinary typo-then-correct, not just by attack, and what it unlocks is
// recovery mail, requesters' private notes, and the giver's own address at
// choose time. Two independent conditions below now have to hold, and
// between them they cover every way `owners.email` can move (there are
// exactly three writers of that column: `POST /email` and `DELETE /email`
// here, and `POST /api/listings`, which always mints a fresh token straight
// after writing).
meRoutes.get("/email/verify", async (c) => {
  const siteUrl = c.env.SITE_URL;
  const token = c.req.query("token");
  if (!token) {
    return c.redirect(`${siteUrl}/mine?verified=0&reason=invalid`, 302);
  }

  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT id, owner_id, email, created_at, expires_at, used_at FROM recovery_tokens WHERE token_hash = ? AND purpose = 'verify_email'`,
  )
    .bind(tokenHash)
    .first<{ id: string; owner_id: string; email: string | null; created_at: number; expires_at: number; used_at: number | null }>();

  if (!row || row.used_at !== null) {
    return c.redirect(`${siteUrl}/mine?verified=0&reason=invalid`, 302);
  }
  if (row.expires_at < now) {
    return c.redirect(`${siteUrl}/mine?verified=0&reason=expired`, 302);
  }

  // Condition 1 — the address this link was mailed to, where we recorded it
  // (migration 20260907181446_recovery_tokens_email.sql), must still be the
  // address on the owner row. `NULL` means a mint site that predates the
  // column, which condition 2 covers instead.
  const owner = await c.env.DB.prepare("SELECT email FROM owners WHERE id = ?")
    .bind(row.owner_id)
    .first<{ email: string | null }>();
  const addressMatches = row.email !== null ? owner?.email === row.email : true;

  // Condition 2 — no newer `verify_email` token exists for this owner. Both
  // writers of `owners.email` mint one immediately after changing it, so a
  // newer token is proof the address moved after this link was sent. This is
  // what fails a `NULL`-address token closed: legacy rows and rows minted by
  // `POST /api/listings` (which does not record the address, and which this
  // branch deliberately does not edit — another session owns that file) are
  // still refused the moment the address is changed again by any route.
  const newer = await c.env.DB.prepare(
    `SELECT id FROM recovery_tokens WHERE owner_id = ? AND purpose = 'verify_email' AND created_at > ? LIMIT 1`,
  )
    .bind(row.owner_id, row.created_at)
    .first<{ id: string }>();

  if (!addressMatches || newer !== null || owner?.email == null) {
    // Burn it rather than leaving it live: a link that has been overtaken is
    // never going to become correct again, and leaving it redeemable is the
    // whole bug. Reported as `invalid` — the same undifferentiated answer
    // this route already gives for unknown and already-used tokens, and from
    // the clicker's side that is exactly what it is.
    await c.env.DB.prepare("UPDATE recovery_tokens SET used_at = ? WHERE id = ?").bind(now, row.id).run();
    return c.redirect(`${siteUrl}/mine?verified=0&reason=invalid`, 302);
  }

  await c.env.DB.prepare("UPDATE recovery_tokens SET used_at = ? WHERE id = ?").bind(now, row.id).run();
  await c.env.DB.prepare("UPDATE owners SET email_verified_at = ? WHERE id = ?").bind(now, row.owner_id).run();

  return c.redirect(`${siteUrl}/mine?verified=1`, 302);
});

/**
 * Mark every unused, unexpired `verify_email` token for this owner as used.
 *
 * Issue #167's write-side half: called from both routes here that change
 * `owners.email`, so a link already in an inbox stops working the instant
 * the address it was mailed to stops being the address on file. `recover`
 * tokens are deliberately untouched — losing your device and correcting a
 * typo are unrelated events, and killing a live recovery link because
 * someone edited their address would break the one path that exists for
 * people who have already lost access.
 */
async function invalidateOutstandingVerifyTokens(env: Env, ownerId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE recovery_tokens SET used_at = ? WHERE owner_id = ? AND purpose = 'verify_email' AND used_at IS NULL`,
  )
    .bind(now, ownerId)
    .run();
}
