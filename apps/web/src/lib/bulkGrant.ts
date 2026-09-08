/**
 * Local storage for the estate bulk-upload admission grant id
 * (`BULK_GRANT_HEADER` / `x-bulk-grant`, `@keepsake/contracts/bulk`).
 *
 * There is no self-serve way to obtain a grant — `docs/design/bulk-upload.md`
 * and `apps/api/src/routes/admin.ts`'s own comment on `POST
 * /api/admin/bulk/grants` are explicit that minting one is an operator
 * action for the pilot, done by hand, with the resulting id handed to the
 * giver out of band. So this module's whole job is remembering whatever id
 * the giver was given — pasted in, or carried on a `?grant=` link the
 * operator sent them — so every write in a sitting can resend it without
 * asking again.
 *
 * `secretStore` (not `prefStore`) only because it's already the
 * SSR-guarded, try/catch-wrapped `localStorage` wrapper this app has —
 * `BULK_GRANT_HEADER`'s own doc comment says a grant id is deliberately
 * **not a secret** (it says only *how much* admission exists, never *who*
 * holds it), so nothing here treats it as one.
 */
import { secretStore } from "@/lib/secretStore";

const GRANT_STORAGE_KEY = "keepsake.bulk.grantId.v1";

export function getStoredGrantId(): string {
  return secretStore.getItem(GRANT_STORAGE_KEY) ?? "";
}

export function setStoredGrantId(grantId: string): void {
  const trimmed = grantId.trim();
  if (trimmed === "") {
    secretStore.removeItem(GRANT_STORAGE_KEY);
    return;
  }
  secretStore.setItem(GRANT_STORAGE_KEY, trimmed);
}

export function clearStoredGrantId(): void {
  secretStore.removeItem(GRANT_STORAGE_KEY);
}
