import { z } from "zod";
import { UlidSchema } from "./common";
import { OwnerListing } from "./listing";

/**
 * Shape returned by the vision model for each photo. Deliberately not
 * `.strict()`: the model is prompted for exactly these keys but is free to
 * add commentary fields, and we'd rather ignore extras than fail the parse.
 * Numeric fields are coerced because the model sometimes emits `"0.4"`.
 */
export const ImageVerdictSchema = z.object({
  is_physical_object: z.boolean(),
  nsfw: z.coerce.number().min(0).max(1),
  violence: z.coerce.number().min(0).max(1),
  weapons: z.coerce.number().min(0).max(1),
  drugs: z.coerce.number().min(0).max(1),
  hate_symbols: z.coerce.number().min(0).max(1),
  personal_info: z.coerce.number().min(0).max(1),
  notes: z.string().max(200),
});
export type ImageVerdict = z.infer<typeof ImageVerdictSchema>;

/** Llama Guard's `safe` / `unsafe\nS<codes>` output, parsed. */
export type TextVerdict =
  | { verdict: "safe" }
  | { verdict: "unsafe"; codes: string[] };

export const AdminQueueItem = OwnerListing;
export type AdminQueueItem = z.infer<typeof AdminQueueItem>;

export const AdminActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), listing_id: UlidSchema }),
  z.object({ type: z.literal("hide"), listing_id: UlidSchema, reason: z.string().max(500).optional() }),
  z.object({ type: z.literal("restore"), listing_id: UlidSchema }),
  z.object({ type: z.literal("ban"), owner_id: UlidSchema, reason: z.string().max(500).optional() }),
  z.object({ type: z.literal("unban"), owner_id: UlidSchema }),
]);
export type AdminAction = z.infer<typeof AdminActionSchema>;
