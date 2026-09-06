import { z } from "zod";
import { EmailSchema, MailableEmailSchema, TimestampMs, UlidSchema } from "./common";

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

export const REQUEST_STATUSES = ["open", "chosen", "not_chosen", "withdrawn"] as const;
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
