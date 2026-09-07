import { z } from "zod";
import { DateOfBirthSchema, EmailSchema, MailableEmailSchema, TimestampMs, UlidSchema } from "./common";

export const NOTE_MIN = 10;
export const NOTE_MAX = 500;

/** Loose E.164-ish: digits, optional leading +, spaces allowed for display. */
export const PhoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^\+?[0-9 ]+$/, "Digits, spaces, and a leading + only");

export const CreateRequestInput = z.object({
  note: z.string().trim().min(NOTE_MIN).max(NOTE_MAX),
  email: MailableEmailSchema,
  phone: PhoneSchema.optional(),
  // Minimum age (docs/legal-considerations.md, issue #64) — see
  // `DateOfBirthSchema`'s own doc comment in `./common`. A requester never
  // has an account, so unlike a listing's owner there is no "attested once,
  // don't ask again" — every request re-attests.
  date_of_birth: DateOfBirthSchema,
});
export type CreateRequestInput = z.infer<typeof CreateRequestInput>;

/** `POST /api/listings/:id/requests` response — just enough for the client
 * to confirm the ask landed and show a timestamp; full request state lives
 * behind the owner's dashboard (`OwnerViewRequest`), not here. */
export const CreateRequestResult = z.object({
  id: UlidSchema,
  created_at: TimestampMs,
});
export type CreateRequestResult = z.infer<typeof CreateRequestResult>;

// `removed` is distinct from `withdrawn`: both erase note/email/phone, but
// `withdrawn` is the requester's own action via POST /api/requests/withdraw
// and `removed` is an admin action via POST /api/admin/requests/:id/remove
// (see docs/runbooks/admin.md's minor-takedown rule) — the owner dashboard
// must not attribute an admin's removal to the requester, so the two need
// separate statuses rather than collapsing into one.
//
// `unconfirmed` (issue #188) is deliberately *not* in this list. It is a real
// `requests.status` value — the state a request sits in between being
// submitted and the requester clicking the "was this you?" link — but this
// enum types what a *giver* can be shown, and an unconfirmed request is
// exactly the thing a giver must never see: an address nobody has proved they
// control. Every owner-facing query filters on `confirmed_at IS NOT NULL`
// (`routes/me.ts`), so leaving the value out here is a second, failing-loud
// layer: if one of those filters is ever dropped, `OwnerViewRequest` throws on
// parse rather than quietly serialising an unverified stranger into a
// dashboard.
export const REQUEST_STATUSES = ["open", "chosen", "not_chosen", "withdrawn", "removed"] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

/**
 * `email`/`phone` are only populated by the API once a request has been
 * chosen — until then the owner only sees the masked forms.
 *
 * `notify_failed`: whether the automated email that matters for this
 * request's current status actually went out — the owner-notify sent when
 * the request came in (`status: "open"`) or the requester-notify sent when
 * it was chosen (`status: "chosen"`). Issue #6: `sendMail()` always returned
 * `{ sent: false, reason }` on a rejected recipient, but nothing before this
 * surfaced that past a `console.error` and an `email_events` row — the
 * give/request/choose flow reported success to the giver either way. A
 * plain boolean, not the raw reason string, so the dashboard can warn
 * without echoing provider internals.
 */
export const OwnerViewRequest = z.object({
  id: UlidSchema,
  note: z.string(),
  created_at: TimestampMs,
  status: RequestStatusSchema,
  email_masked: z.string(),
  phone_masked: z.string().optional(),
  email: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  notify_failed: z.boolean(),
});
export type OwnerViewRequest = z.infer<typeof OwnerViewRequest>;

export const ChooseRequestInput = z.object({
  request_id: UlidSchema,
  handoff_note: z.string().trim().max(500),
});
export type ChooseRequestInput = z.infer<typeof ChooseRequestInput>;

/** "jane.doe@example.com" -> "j•••@example.com" */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const domain = email.slice(at);
  const firstChar = email.slice(0, 1);
  return `${firstChar}•••${domain}`;
}

/** Keeps the leading "+" (if any) and the last two digits; masks the rest. */
export function maskPhone(phone: string): string {
  const hasPlus = phone.trim().startsWith("+");
  const digits = phone.replace(/\D/g, "");

  if (digits.length <= 2) {
    return `${hasPlus ? "+" : ""}${"•".repeat(digits.length)}`;
  }

  const visible = digits.slice(-2);
  const masked = "•".repeat(digits.length - 2) + visible;
  return `${hasPlus ? "+" : ""}${masked}`;
}

/** Shown in place of `email_masked`/`note` once a request has been withdrawn
 * and its personal fields erased server-side — see
 * `POST /api/requests/withdraw` and `docs/design/identity.md`'s "Request
 * withdrawal" section. Distinguishes "withdrawn, PII erased" from "chosen"
 * or "open" in the owner dashboard without exposing what used to be there. */
export const WITHDRAWN_REQUEST_PLACEHOLDER = "(withdrawn — removed by the requester)";

/** Same idea as `WITHDRAWN_REQUEST_PLACEHOLDER`, for the admin-initiated
 * counterpart (`POST /api/admin/requests/:id/remove`). Kept as an honest,
 * distinct message rather than reusing the requester-attributed one above —
 * see `REQUEST_STATUSES`'s doc comment for why the two statuses don't
 * collapse into one. */
export const ADMIN_REMOVED_REQUEST_PLACEHOLDER = "(removed by Keepsake)";

/**
 * `POST /api/requests/withdraw` — the no-account path for a requester to pull
 * back their own note/email/phone. `token` is the raw, single-use secret
 * mailed as a link in the confirmation sent when the request was created
 * (`src/email/templates/requestReceived.ts`), the same
 * mint-random-hash-only-the-hash-persists shape every other bearer secret in
 * this API uses (`apps/api/src/lib/tokens.ts`).
 */
export const RequestWithdrawInput = z.object({
  token: z.string().trim().min(1),
});
export type RequestWithdrawInput = z.infer<typeof RequestWithdrawInput>;

export const RequestWithdrawResult = z.object({
  id: UlidSchema,
  listing_id: UlidSchema,
  withdrawn_at: TimestampMs,
});
export type RequestWithdrawResult = z.infer<typeof RequestWithdrawResult>;

/**
 * `POST /api/requests/confirm` — issue #188. `token` is the raw, single-use
 * secret mailed as a link in `confirmRequest`
 * (`src/email/templates/confirmRequest.ts`), the only message that goes to an
 * address before anyone has proved they control it. Redeeming it is what
 * turns a held request into a real one: it is forwarded to the giver, counted
 * toward `request_count`, and given its withdraw token at that moment and not
 * before.
 */
export const RequestConfirmInput = z.object({
  token: z.string().trim().min(1),
});
export type RequestConfirmInput = z.infer<typeof RequestConfirmInput>;

/**
 * `listing_available` is false when the keepsake stopped being claimable
 * between the ask and the confirmation — given to someone else, withdrawn by
 * the giver, taken down. The request is still confirmed in that case (the
 * person did ask, and their withdraw link has to work), but nothing was
 * forwarded to the giver and the page says so rather than implying an ask is
 * pending on a listing that is gone.
 */
export const RequestConfirmResult = z.object({
  id: UlidSchema,
  listing_id: UlidSchema,
  /** Null when `listing_available` is false — nothing was confirmed, because
   * there was nothing left to forward the request to. */
  confirmed_at: TimestampMs.nullable(),
  listing_available: z.boolean(),
});
export type RequestConfirmResult = z.infer<typeof RequestConfirmResult>;
