/**
 * `GET /api/admin/observatory` — the client for the Observatory panel.
 *
 * Its own module rather than more of `src/api/admin.ts`, mirroring the
 * contract's own split (see `@keepsake/contracts/observatory`'s file
 * header): the admin queue is about one listing, this is about the system.
 *
 * `Observatory` is a plain TS type, not a zod schema — same reasoning the
 * contract gives for `AdminStats`/`AdminHealth`: a server-computed payload
 * the client only ever renders, never a client-submitted shape the server
 * must validate. So, exactly like `getAdminStats`/`getAdminHealth` in
 * `src/api/admin.ts`, this is a shape-cast (`apiFetch<Observatory>`), not a
 * `.parse()`.
 */
import type { Observatory } from "@keepsake/contracts/observatory";
import { apiFetch } from "@/api/client";

export type GetObservatoryOptions = {
  /** One of `OBSERVATORY_WINDOWS` (`@keepsake/contracts/observatory`) — not
   * narrowed to that union here, so a caller can pass the value straight out
   * of `React.useState` without a second cast. The server re-validates it
   * against `ObservatoryWindowSchema` regardless. */
  windowDays: number;
  signal?: AbortSignal;
};

export async function getObservatory(adminToken: string, options: GetObservatoryOptions): Promise<Observatory> {
  const params = new URLSearchParams({ window_days: String(options.windowDays) });
  return apiFetch<Observatory>(`/api/admin/observatory?${params.toString()}`, {
    adminToken,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}
