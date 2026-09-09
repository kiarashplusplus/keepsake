import { z } from "zod";

/** `GET`/`POST /api/unsubscribe/:token` and `POST /api/resubscribe/:token`
 * all answer with the resulting state — the token's own status, never
 * anything that would identify the address behind it (there is nothing to
 * identify it with: the token is a one-way HMAC, see
 * `apps/api/src/email/unsubscribe.ts`). */
export const UnsubscribeStatusResult = z.object({
  unsubscribed: z.boolean(),
});
export type UnsubscribeStatusResult = z.infer<typeof UnsubscribeStatusResult>;
