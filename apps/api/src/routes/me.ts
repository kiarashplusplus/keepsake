import { Hono } from "hono";
import { SetEmailInput, type OwnerMe } from "@keepsake/contracts/owner";
import type { ModerationReasonCode } from "@keepsake/contracts/listing";
import { ChooseRequestInput, maskEmail, maskPhone, type OwnerViewRequest } from "@keepsake/contracts/request";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { turnstile } from "../middleware/turnstile.js";
import { burst } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { serializeOwnerListing } from "../lib/serialize.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
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
  note: string;
  email: string;
  phone: string | null;
  status: string;
  created_at: number;
}

function serializeOwnerViewRequest(row: RequestRow): OwnerViewRequest {
  const revealed = row.status === "chosen";
  return {
    id: row.id,
    note: row.note,
    created_at: row.created_at,
    status: row.status as OwnerViewRequest["status"],
    email_masked: maskEmail(row.email),
    ...(row.phone !== null ? { phone_masked: maskPhone(row.phone) } : {}),
    ...(revealed ? { email: row.email } : {}),
    ...(revealed && row.phone !== null ? { phone: row.phone } : {}),
  };
}

const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

meRoutes.get("/", ownerAuth(), (c) => {
  const owner = c.get("owner");
  const me: OwnerMe = {
    id: owner.id,
    ...(owner.email !== null ? { email: owner.email } : {}),
    email_verified: owner.email_verified_at !== null,
    banned: owner.banned_at !== null,
  };
  return ok(c, me);
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

  const items = [];
  for (const row of rows) {
    const photos = await fetchPhotoRows(c.env, row.id);
    items.push(serializeOwnerListing(row, photos));
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
  const ownerListing = serializeOwnerListing(row, photos);

  const { results: requestRows } = await c.env.DB.prepare(
    "SELECT id, note, email, phone, status, created_at FROM requests WHERE listing_id = ? ORDER BY created_at",
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

  const request = await c.env.DB.prepare("SELECT id, listing_id, note, email, phone, status, created_at FROM requests WHERE id = ?")
    .bind(input.request_id)
    .first<RequestRow & { listing_id: string }>();

  if (!request || request.listing_id !== id) {
    return fail(c, "not_found", "Request not found.", 404);
  }
  if (request.status !== "open") {
    return fail(c, "conflict", "This request has already been decided.", 409);
  }

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
  await sendMail(c.env, {
    kind: "chosen",
    to: request.email,
    ...(giverVerified ? { replyTo: owner.email as string } : {}),
    ...template,
  });

  const revealed: OwnerViewRequest = {
    id: request.id,
    note: request.note,
    created_at: request.created_at,
    status: "chosen",
    email_masked: maskEmail(request.email),
    ...(request.phone !== null ? { phone_masked: maskPhone(request.phone) } : {}),
    email: request.email,
    ...(request.phone !== null ? { phone: request.phone } : {}),
  };
  return ok(c, revealed);
});

// ---------------------------------------------------------------------------
// POST/DELETE /api/me/email, GET /api/me/email/verify
// ---------------------------------------------------------------------------
meRoutes.post("/email", ownerAuth(), turnstile(), burst("RL_EMAIL"), validateBody(SetEmailInput), async (c) => {
  const owner = c.get("owner");
  const input = c.get("validatedBody") as import("@keepsake/contracts/owner").SetEmailInput;
  const now = Date.now();

  await c.env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = NULL WHERE id = ?").bind(input.email, owner.id).run();

  const rawToken = randomTokenRaw();
  const tokenHash = await sha256Hex(rawToken);
  await c.env.DB.prepare(
    `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at)
     VALUES (?, ?, 'verify_email', ?, ?, ?)`,
  )
    .bind(ulid(), owner.id, tokenHash, now + VERIFY_EMAIL_TTL_MS, now)
    .run();

  const verifyUrl = `${c.env.SITE_URL}/api/me/email/verify?token=${rawToken}`;
  await sendMail(c.env, { kind: "verify_email", to: input.email, ...verifyEmail({ link: verifyUrl }) });

  return ok(c, { email: input.email, email_verified: false });
});

meRoutes.delete("/email", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  await c.env.DB.prepare("UPDATE owners SET email = NULL, email_verified_at = NULL WHERE id = ?").bind(owner.id).run();
  return ok(c, { id: owner.id });
});

// Not `ownerAuth()`-guarded: this is a link clicked from an email, not an
// API call carrying the owner's bearer token — the single-use recovery
// token in the query string *is* the credential here.
meRoutes.get("/email/verify", async (c) => {
  const siteUrl = c.env.SITE_URL;
  const token = c.req.query("token");
  if (!token) {
    return c.redirect(`${siteUrl}/mine?verified=0&reason=invalid`, 302);
  }

  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT id, owner_id, expires_at, used_at FROM recovery_tokens WHERE token_hash = ? AND purpose = 'verify_email'`,
  )
    .bind(tokenHash)
    .first<{ id: string; owner_id: string; expires_at: number; used_at: number | null }>();

  if (!row || row.used_at !== null) {
    return c.redirect(`${siteUrl}/mine?verified=0&reason=invalid`, 302);
  }
  if (row.expires_at < now) {
    return c.redirect(`${siteUrl}/mine?verified=0&reason=expired`, 302);
  }

  await c.env.DB.prepare("UPDATE recovery_tokens SET used_at = ? WHERE id = ?").bind(now, row.id).run();
  await c.env.DB.prepare("UPDATE owners SET email_verified_at = ? WHERE id = ?").bind(now, row.owner_id).run();

  return c.redirect(`${siteUrl}/mine?verified=1`, 302);
});
