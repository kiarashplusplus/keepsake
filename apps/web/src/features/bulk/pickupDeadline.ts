/**
 * A batch's private pickup deadline — a personal reminder for the giver
 * ("I want this cleared out by the 30th"), never a promise the product
 * makes to anyone else and never sent to the API: neither
 * `CreateBatchInput` nor `BulkBatchMeta` (both fixed — a wire contract and
 * a reducer this agent doesn't own) has anywhere to carry one, on purpose —
 * this feature explicitly does not promise every item goes live together or
 * before a deadline (see the plan's submission section). So it lives here,
 * local-only, the same shape as `itemMarkers.ts`'s bookkeeping: losing it
 * costs nothing but the reminder itself.
 */
import { secretStore } from "@/lib/secretStore";

function storageKey(clientBatchKey: string): string {
  return `keepsake.bulk.deadline.v1.${clientBatchKey}`;
}

/** `YYYY-MM-DD`, or `null` if the giver never set one. */
export function getPickupDeadline(clientBatchKey: string): string | null {
  return secretStore.getItem(storageKey(clientBatchKey));
}

export function setPickupDeadline(clientBatchKey: string, isoDate: string | null): void {
  if (isoDate === null || isoDate.trim() === "") {
    secretStore.removeItem(storageKey(clientBatchKey));
    return;
  }
  secretStore.setItem(storageKey(clientBatchKey), isoDate.trim());
}
