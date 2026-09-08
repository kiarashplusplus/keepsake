/**
 * `/api/admin/*` — every call here takes the admin token explicitly as a
 * parameter (never reads it out of `src/lib/adminToken.ts` itself), so a
 * 401 is always something the caller decides how to react to (kick back to
 * the token-entry screen) rather than something buried inside this module.
 * Response bodies are validated with the same `@keepsake/contracts/admin`
 * zod schemas the API itself validates requests against; `AdminStats`/
 * `AdminHealth` are plain TS types (not schemas — see their doc comments in
 * the contract), so those two are only shape-cast, matching how
 * `src/api/feed.ts` treats `FeedPage<T>`.
 */
import { z } from "zod";
import {
  ADMIN_QUEUE_STATUSES,
  AdminBanInput as AdminBanInputSchema,
  AdminHideInput as AdminHideInputSchema,
  AdminQueueItem,
  AdminRejectInput as AdminRejectInputSchema,
  type AdminBanInput,
  type AdminHealth,
  type AdminHideInput,
  type AdminQueueStatus,
  type AdminRejectInput,
  type AdminStats,
} from "@keepsake/contracts/admin";
import { feedPageSchema, type FeedPage } from "@keepsake/contracts/feed";
import type { OwnerListing } from "@keepsake/contracts/listing";
import { apiFetch } from "@/api/client";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

export { ADMIN_QUEUE_STATUSES };
export type { AdminQueueStatus };

const AdminQueuePage = feedPageSchema(AdminQueueItem);

export type GetAdminQueueOptions = {
  status: AdminQueueStatus;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};

export async function getAdminQueue(adminToken: string, options: GetAdminQueueOptions): Promise<FeedPage<AdminQueueItem>> {
  const params = new URLSearchParams({ status: options.status });
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));

  const data = await apiFetch<unknown>(`/api/admin/queue?${params.toString()}`, {
    adminToken,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return AdminQueuePage.parse(fixPhotoUrls(data));
}

export async function approveListing(adminToken: string, listingId: string): Promise<OwnerListing> {
  return apiFetch<OwnerListing>(`/api/admin/listings/${encodeURIComponent(listingId)}/approve`, {
    method: "POST",
    adminToken,
  });
}

export async function hideListing(adminToken: string, listingId: string, input: AdminHideInput = {}): Promise<OwnerListing> {
  const body = AdminHideInputSchema.parse(input);
  return apiFetch<OwnerListing>(`/api/admin/listings/${encodeURIComponent(listingId)}/hide`, {
    method: "POST",
    body,
    adminToken,
  });
}

export async function restoreListing(adminToken: string, listingId: string): Promise<OwnerListing> {
  return apiFetch<OwnerListing>(`/api/admin/listings/${encodeURIComponent(listingId)}/restore`, {
    method: "POST",
    adminToken,
  });
}

export async function rejectListing(adminToken: string, listingId: string, input: AdminRejectInput): Promise<OwnerListing> {
  const body = AdminRejectInputSchema.parse(input);
  return apiFetch<OwnerListing>(`/api/admin/listings/${encodeURIComponent(listingId)}/reject`, {
    method: "POST",
    body,
    adminToken,
  });
}

const BanResult = z.object({ id: z.string(), banned: z.boolean(), hidden_listings: z.number().int().nonnegative().optional() });
export type BanResult = z.infer<typeof BanResult>;

export async function banOwner(adminToken: string, ownerId: string, input: AdminBanInput = {}): Promise<BanResult> {
  const body = AdminBanInputSchema.parse(input);
  const data = await apiFetch<unknown>(`/api/admin/owners/${encodeURIComponent(ownerId)}/ban`, {
    method: "POST",
    body,
    adminToken,
  });
  return BanResult.parse(data);
}

export async function unbanOwner(adminToken: string, ownerId: string): Promise<BanResult> {
  const data = await apiFetch<unknown>(`/api/admin/owners/${encodeURIComponent(ownerId)}/unban`, {
    method: "POST",
    adminToken,
  });
  return BanResult.parse(data);
}

// #297: `AdminStats`/`AdminHealth` are plain TS types, not contracts' own
// zod schemas (see their doc comments — "plain data, not a client-submitted
// shape"), so unlike every other caller in this module they had nothing
// parsing the response at all: `isEnvelope`'s old looseness meant a
// malformed `{ ok: true }` reached the dashboard as `undefined` rendered as
// though it were real stats/health. `isEnvelope` itself is tightened in
// `src/api/client.ts` to catch that from the other side; these two local
// schemas (same pattern as `BanResult` above — a shape check kept next to
// the caller rather than added to the shared contract) close it here too, so
// a body that *looks* like an envelope but doesn't match either shape fails
// loudly instead of shipping blank panels on the one page whose job is
// telling Kiarash something's stuck.
const AdminEmailDomainStatsSchema = z.object({
  domain: z.string(),
  attempted: z.number(),
  failed: z.number(),
  top_reason: z.string(),
});

const AdminEmailEventStatsSchema = z.object({
  window_days: z.number(),
  total: z.number(),
  ok: z.number(),
  failed: z.number(),
  by_error: z.array(z.object({ error: z.string(), count: z.number() })),
  failures_by_domain: z.array(AdminEmailDomainStatsSchema),
});

const AdminStatsSchema = z.object({
  listings_by_status: z.record(z.string(), z.number()),
  requests_today: z.number(),
  email_failures_today: z.number(),
  ai_budget_used_today: z.object({ mod_text: z.number(), mod_image: z.number() }),
  email_events_7d: AdminEmailEventStatsSchema,
}) satisfies z.ZodType<AdminStats>;

const AdminReportPressureSchema = z.object({
  threshold: z.number(),
  autohidden_awaiting_review: z.array(
    z.object({ listing_id: z.string(), report_count: z.number(), autohidden_at: z.number() }),
  ),
  near_threshold: z.array(z.object({ listing_id: z.string(), report_count: z.number() })),
});

const AdminHealthSchema = z.object({
  ok: z.boolean(),
  postal_codes_count: z.number(),
  cron_last_run: z.record(z.string(), z.number().nullable()),
  report_pressure: AdminReportPressureSchema,
}) satisfies z.ZodType<AdminHealth>;

export async function getAdminStats(adminToken: string, signal?: AbortSignal): Promise<AdminStats> {
  const data = await apiFetch<unknown>("/api/admin/stats", { adminToken, ...(signal !== undefined ? { signal } : {}) });
  return AdminStatsSchema.parse(data);
}

export async function getAdminHealth(adminToken: string, signal?: AbortSignal): Promise<AdminHealth> {
  const data = await apiFetch<unknown>("/api/admin/health", { adminToken, ...(signal !== undefined ? { signal } : {}) });
  return AdminHealthSchema.parse(data);
}
