import { z } from "zod";
import { EmailSchema, MailableEmailSchema, UlidSchema } from "./common";

export const OWNER_TOKEN_PREFIX = "ks_";

/** `ks_` + 43 base64url chars (32 random bytes, unpadded). */
export const OwnerTokenSchema = z
  .string()
  .regex(new RegExp(`^${OWNER_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`), "Invalid owner token");

export function isOwnerToken(value: unknown): value is string {
  return typeof value === "string" && OwnerTokenSchema.safeParse(value).success;
}

export const OwnerMe = z.object({
  id: UlidSchema,
  email: EmailSchema.optional(),
  email_verified: z.boolean(),
  banned: z.boolean(),
});
export type OwnerMe = z.infer<typeof OwnerMe>;

export const SetEmailInput = z.object({
  email: MailableEmailSchema,
});
export type SetEmailInput = z.infer<typeof SetEmailInput>;

export const RecoverInput = z.object({
  email: MailableEmailSchema,
});
export type RecoverInput = z.infer<typeof RecoverInput>;

/**
 * Body of `POST /api/recover/exchange`.
 *
 * Issue #182: the recovery token used to ride in the URL as
 * `POST /api/recover/<token>`, where `apps/api/src/index.ts`'s `onError`
 * wrote it verbatim into a log field on any thrown request — while the token
 * was still live and still worth full takeover of a giver's dashboard. It
 * travels in the body now, the same shape `RequestWithdrawInput` already
 * uses for a strictly lower-value token: one flow copying the other, rather
 * than two shapes for the same kind of secret.
 *
 * Deliberately `z.string().min(1)` rather than a shape check on the token —
 * identical to `RequestWithdrawInput`. A validator that could reject a
 * malformed token would answer 400 where an unknown one answers 401, and
 * that difference is itself an oracle; the route refuses every bad token
 * the same way instead.
 */
export const RecoverExchangeInput = z.object({
  token: z.string().trim().min(1),
});
export type RecoverExchangeInput = z.infer<typeof RecoverExchangeInput>;

export const RecoverResult = z.object({
  ownerToken: OwnerTokenSchema,
});
export type RecoverResult = z.infer<typeof RecoverResult>;
