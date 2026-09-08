/**
 * The fixed estate batch the UX baseline's bulk screens are captured
 * against — same idea and the same idempotency shape as `demoCatalog.ts`,
 * for the same reason given there: a screenshot only means something next
 * to last month's screenshot if it shows the same batch, the same items,
 * the same words.
 *
 * This used to need one thing `demoCatalog.ts` never did: an admission
 * grant, minted by hand through the admin API for `DEMO_OWNER_TOKEN`
 * because there was no self-serve path onto `/bulk`. The admission code is
 * gone, so seeding is now the plain owner-authed calls below —
 * `POST /api/bulk/batches` creates the `owners` row on sight, the same way
 * a photo upload does. `DEMO_OWNER_TOKEN` is the same fixed device
 * `demoCatalog.ts` uses, so the bulk screens and the ordinary ones are
 * captured as one giver's device, not two.
 *
 * Every field here is set directly through `PUT .../items/:clientItemId`
 * rather than by grouping photos and waiting on `MOCK_AI`'s suggestion —
 * unlike `e2e/bulk.spec.ts`, which is *about* that pipeline, this only wants
 * fixed, reviewable words on the screen, the same reasoning `DEMO_LISTINGS`
 * gives for writing its own titles and stories by hand instead of minting
 * them from a photo.
 */
import type { APIRequestContext } from "@playwright/test";
import { DEMO_OWNER_TOKEN } from "./demoCatalog";
import { readDemoPhoto, readDemoThumb, DEMO_PHOTOS } from "./demoPhotos";
import { freshClientIp, ownerHeaders } from "./api";

const BATCH_NAME = "UX baseline — estate batch";
const CLIENT_BATCH_KEY = "ux-baseline-batch";
const GROUPED_ITEM_KEY = "ux-baseline-item-grouped";

const GROUPED_ITEM_FIELDS = {
  title: "Pressed tin ceiling tile",
  story:
    "Pried loose the week the old dining hall came down, one of a dozen my uncle salvaged before the rest went to the skip. The paint is original, chipped at two corners. It wants a wall, not a box in the garage.",
  category: "photos_art_handmade" as const,
};

const UNGROUPED_PHOTO = DEMO_PHOTOS.plane;

async function readJson<T>(response: { json(): Promise<unknown> }): Promise<T> {
  return (await response.json()) as T;
}

interface BatchSummaryLite {
  id: string;
  client_batch_key: string;
  item_count: number;
  ready_count: number;
}

interface BatchDetailLite {
  items: { client_item_id: string; ready: boolean }[];
}

export interface DemoBulkBatch {
  id: string;
  clientBatchKey: string;
}

/**
 * Seeds the fixed batch if this run hasn't yet, and hands back its id
 * either way. Idempotent the same way `ensureDemoCatalog` is: both baseline
 * projects can call this and the second one finds the first one's work.
 */
export async function ensureDemoBulkBatch(request: APIRequestContext): Promise<DemoBulkBatch> {
  const headers = ownerHeaders(DEMO_OWNER_TOKEN);
  const list = await request.get("/api/bulk/batches", { headers });
  if (list.ok()) {
    const body = await readJson<{ ok: boolean; data?: { items: BatchSummaryLite[] } }>(list);
    const existing = body.data?.items.find((b) => b.client_batch_key === CLIENT_BATCH_KEY);
    if (existing && existing.item_count > 0 && existing.ready_count > 0) {
      return { id: existing.id, clientBatchKey: CLIENT_BATCH_KEY };
    }
  }

  const writeHeaders = { ...headers, "CF-Connecting-IP": freshClientIp() };

  const createRes = await request.post("/api/bulk/batches", {
    headers: writeHeaders,
    data: { client_batch_key: CLIENT_BATCH_KEY, name: BATCH_NAME, country: "US", postal_code: "02144" },
  });
  const created = await readJson<{ ok: boolean; data?: { id: string } }>(createRes);
  const batchId = created.data?.id as string;

  async function uploadPhoto(clientPhotoId: string, photo: (typeof DEMO_PHOTOS)[keyof typeof DEMO_PHOTOS]): Promise<void> {
    await request.put(`/api/bulk/batches/${batchId}/photos/${clientPhotoId}`, {
      headers: writeHeaders,
      multipart: {
        full: { name: `${photo.key}.jpg`, mimeType: "image/jpeg", buffer: readDemoPhoto(photo) },
        thumb: { name: `${photo.key}.thumb.jpg`, mimeType: "image/jpeg", buffer: readDemoThumb(photo) },
        width: String(photo.width),
        height: String(photo.height),
        blurhash: photo.blurhash,
      },
    });
  }

  // Two photos grouped into one filled-in, ready item (the Review/Submit
  // screens' main subject), and a third left in the tray unassigned (so the
  // Photos screen's "add and group" state — the point of that screen — is
  // actually on show, not an empty tray or an all-grouped one).
  await uploadPhoto("ux-photo-a", DEMO_PHOTOS.kettle);
  await uploadPhoto("ux-photo-b", DEMO_PHOTOS.brooch);
  await uploadPhoto("ux-photo-c", UNGROUPED_PHOTO);

  await request.put(`/api/bulk/batches/${batchId}/items/${GROUPED_ITEM_KEY}`, {
    headers: writeHeaders,
    data: {
      fields: GROUPED_ITEM_FIELDS,
      room_label: "Attic",
      lot_label: "Box 3",
      photo_client_ids: ["ux-photo-a", "ux-photo-b"],
    },
  });

  const detailRes = await request.get(`/api/bulk/batches/${batchId}`, { headers });
  const detail = await readJson<{ ok: boolean; data?: BatchDetailLite }>(detailRes);
  const readyItem = detail.data?.items.find((i) => i.client_item_id === GROUPED_ITEM_KEY);
  if (!readyItem?.ready) {
    throw new Error("ensureDemoBulkBatch: seeded item never reached ready — check GROUPED_ITEM_FIELDS against CreateListingInput");
  }

  return { id: batchId, clientBatchKey: CLIENT_BATCH_KEY };
}
