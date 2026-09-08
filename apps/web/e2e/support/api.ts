/**
 * Test data is created through the real API, never by writing rows into D1.
 *
 * Two reasons. Any listing a spec asserts on then has a genuine photo in R2,
 * a real `owners` row, and a real moderation decision behind it (`MOCK_AI=1`
 * makes that decision instant and always-approve — see
 * `apps/api/src/moderation/{text,image}.ts`), so a spec can't pass against a
 * shape the product itself would never produce. And because every fixture is
 * unique per call, two specs running in parallel — or the same spec re-run
 * against a `reuseExistingServer` server — can never collide over one shared
 * seed row.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { makePng } from "./png";
import { readDemoPhoto, readDemoThumb, type DemoPhoto } from "./demoPhotos";

/** Matches `OwnerTokenSchema`: `ks_` + 43 unpadded base64url characters. */
const OWNER_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const OWNER_TOKEN_STORAGE_KEY = "keepsake.ownerToken.v1";
export const ADMIN_TOKEN = "e2e-admin";

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

export function mintOwnerToken(): string {
  let suffix = "";
  for (let i = 0; i < 43; i += 1) suffix += OWNER_TOKEN_ALPHABET[randomInt(OWNER_TOKEN_ALPHABET.length)];
  return `ks_${suffix}`;
}

/**
 * A fresh `CF-Connecting-IP` per browser context / API helper.
 *
 * `wrangler dev` really does honour this header (verified: two POSTs to
 * `/api/listings/:id/reports` with different values produce two rows rather
 * than a 409), and everything this Worker rations is keyed off it — the
 * `[[ratelimits]]` bindings in `wrangler.toml` (`RL_CREATE` 5/60s,
 * `RL_REPORT` 5/60s, …), which *are* enforced under `wrangler dev`, and the
 * per-IP daily KV counters in `src/moderation/budget.ts`. Without a distinct
 * address per test the whole suite would share the single `"unknown"` key and
 * start 429ing itself the moment two specs run in parallel.
 *
 * RFC 5737's documentation ranges are too small to make collisions unlikely,
 * so this uses RFC 1918 space: 16 million addresses, no chance of a real one.
 */
export function freshClientIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

export function ownerHeaders(token: string, clientIp = freshClientIp()): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "CF-Connecting-IP": clientIp };
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function readData<T>(response: { ok(): boolean; status(): number; json(): Promise<unknown>; url(): string }): Promise<T> {
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!body.ok || body.data === undefined) {
    throw new Error(`${response.url()} -> ${response.status()} ${JSON.stringify(body.error ?? body)}`);
  }
  return body.data;
}

export interface CreatedListing {
  id: string;
  title: string;
  story: string;
  ownerToken: string;
}

export interface CreateListingOptions {
  title: string;
  story?: string;
  category?: string;
  postalCode?: string;
  /** Reuse an existing device identity, e.g. so the giver's browser context
   * can be handed the same token and find the listing under `/mine`. */
  ownerToken?: string;
  /** The giver's address. Defaults rather than being omitted: `POST
   * /api/listings` refuses a first listing from an owner with no way back to
   * them, so "no email" is not a shape the real product can produce any
   * more — a spec that wants an unreachable giver removes the address
   * afterwards (`DELETE /api/me/email`) instead. */
  email?: string;
  /** Issue #36/#39: the aspects a real photo-suggestion call would have
   * produced. Omit entirely (not `[]`) to exercise the issue #40 zero-aspect
   * case — `CreateListingInput.aspects` defaults to `[]` server-side either
   * way, but omitting it here is what a give flow with a suggestion the
   * giver never applied actually sends. */
  aspects?: Array<{ name: string; value: string }>;
  /** A real photograph from `e2e/fixtures/photos`, for the UX baseline. Left
   * unset everywhere else on purpose: the functional specs want `png.ts`'s
   * generated gradient, which asserts the same pipeline without reading a
   * megabyte off disk per listing. */
  photo?: DemoPhoto;
}

/**
 * Uploads a photo, creates the listing, and waits for the moderation pipeline
 * to publish it. `POST /api/listings` returns while `moderateListing()` is
 * still running in `waitUntil()`, so the listing is `pending` for a beat
 * before `MOCK_AI` approves it — polling `GET /api/listings/:id` (which only
 * ever answers for `approved`/`given`) is the honest way to wait for that,
 * and it is what the give flow's own review screen does.
 */
export async function createApprovedListing(
  request: APIRequestContext,
  options: CreateListingOptions,
): Promise<CreatedListing> {
  const ownerToken = options.ownerToken ?? mintOwnerToken();
  const headers = ownerHeaders(ownerToken);
  const story =
    options.story ??
    "A small thing that sat on my grandmother's shelf for thirty years, and I would like it to sit on someone else's now.";

  // A real JPEG when the caller supplied one (`imageSniff.ts` allows jpeg,
  // png and webp, so both paths sniff clean), otherwise the generated PNG.
  // The dimensions and blurhash have to describe whichever image is actually
  // sent: the API stores them rather than decoding, `clampCardAspectRatio()`
  // lays the card out from the ratio, and the blurhash is what shows while
  // the photo decodes.
  const uploadResponse = await request.put("/api/photos", {
    headers,
    multipart: options.photo
      ? {
          full: { name: `${options.photo.key}.jpg`, mimeType: "image/jpeg", buffer: readDemoPhoto(options.photo) },
          thumb: { name: `${options.photo.key}.thumb.jpg`, mimeType: "image/jpeg", buffer: readDemoThumb(options.photo) },
          width: String(options.photo.width),
          height: String(options.photo.height),
          blurhash: options.photo.blurhash,
        }
      : {
          full: { name: "full.png", mimeType: "image/png", buffer: makePng(400, 500, 1) },
          thumb: { name: "thumb.png", mimeType: "image/png", buffer: makePng(160, 200, 2) },
          width: "400",
          height: "500",
          blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        },
  });
  const photo = await readData<{ id: string }>(uploadResponse);

  const createResponse = await request.post("/api/listings", {
    headers,
    data: {
      title: options.title,
      story,
      category: options.category ?? "home_kitchen",
      country: "US",
      postal_code: options.postalCode ?? "02144",
      photo_ids: [photo.id],
      date_of_birth: "1990-01-01",
      email: options.email ?? "giver@keepsake.ing",
      ...(options.aspects !== undefined ? { aspects: options.aspects } : {}),
    },
  });
  const created = await readData<{ id: string }>(createResponse);

  await expect
    .poll(async () => (await request.get(`/api/listings/${created.id}`)).status(), {
      message: `listing ${created.id} never reached approved`,
      timeout: 20_000,
    })
    .toBe(200);

  return { id: created.id, title: options.title, story, ownerToken };
}

/** `POST /api/listings/:id/requests` as an anonymous stranger. */
export async function sendRequest(
  request: APIRequestContext,
  listingId: string,
  body: { note: string; email: string; phone?: string },
): Promise<{ id: string }> {
  const response = await request.post(`/api/listings/${listingId}/requests`, {
    headers: { "CF-Connecting-IP": freshClientIp() },
    data: { ...body, date_of_birth: "1990-01-01" },
  });
  return readData<{ id: string }>(response);
}

export function adminHeaders(clientIp = freshClientIp()): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "CF-Connecting-IP": clientIp };
}

/** `POST /api/admin/listings/:id/hide` — the only way to *make* a hidden
 * listing without three reporters, and the same call the admin page fires. */
export async function hideListingAsAdmin(request: APIRequestContext, listingId: string, reason: string): Promise<void> {
  const response = await request.post(`/api/admin/listings/${listingId}/hide`, {
    headers: adminHeaders(),
    data: { reason },
  });
  await readData(response);
}

/** A title no other listing (or run) can share, so a feed assertion is exact
 * even though the local feed accumulates rows from every spec. */
export function uniqueTitle(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
}
