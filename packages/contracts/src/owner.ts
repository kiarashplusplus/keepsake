import { z } from "zod";
import { EmailSchema, UlidSchema } from "./common";

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
  email: EmailSchema,
});
export type SetEmailInput = z.infer<typeof SetEmailInput>;

export const RecoverInput = z.object({
  email: EmailSchema,
});
export type RecoverInput = z.infer<typeof RecoverInput>;

export const RecoverResult = z.object({
  ownerToken: OwnerTokenSchema,
});
export type RecoverResult = z.infer<typeof RecoverResult>;
