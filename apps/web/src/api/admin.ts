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

export async function getAdminStats(adminToken: string, signal?: AbortSignal): Promise<AdminStats> {
  return apiFetch<AdminStats>("/api/admin/stats", { adminToken, ...(signal !== undefined ? { signal } : {}) });
}

export async function getAdminHealth(adminToken: string, signal?: AbortSignal): Promise<AdminHealth> {
  return apiFetch<AdminHealth>("/api/admin/health", { adminToken, ...(signal !== undefined ? { signal } : {}) });
}
