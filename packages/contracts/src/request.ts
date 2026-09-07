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
export const REQUEST_STATUSES = ["open", "chosen", "not_chosen", "withdrawn", "removed"] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

/**
 * `email`/`phone` are only populated by the API once a request has been
 * chosen — until then the owner only sees the masked forms.
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
