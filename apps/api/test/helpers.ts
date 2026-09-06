/** Shared fixtures for the M1 route/pipeline tests: synthetic owner tokens,
 * minimal-but-valid image bytes, and small request-building helpers. Kept
 * out of any one test file since photos/listings/moderation tests all need
 * the same building blocks. */
import { env, SELF } from "cloudflare:test";

let tokenCounter = 0;
let ipCounter = 0;

/** A syntactically valid `ks_<43 base64url chars>` token — matches
 * `OwnerTokenSchema` — unique per call so tests don't collide on the same
 * `owners` row. */
export function freshOwnerToken(): string {
  tokenCounter += 1;
  const suffix = tokenCounter.toString(36).padStart(8, "0");
  return `ks_${suffix}${"A".repeat(43 - suffix.length)}`;
}

/** A fresh opaque string used as `CF-Connecting-IP`. Real IP shape doesn't
 * matter — `clientIPFrom`/the budget digest treat it as an opaque string —
 * only uniqueness does: without this, every request in a test file shares
 * the same `"unknown"` IP and the `[[ratelimits]]` burst bindings (which do
 * work under vitest-pool-workers, e.g. `RL_CREATE` at 5/60s) and the per-IP
 * daily KV budgets both treat unrelated tests as one very chatty caller. */
/**
 * `wrangler types` gives each `[vars]` entry a single string-literal type
 * matching whatever's currently in `wrangler.toml`/`vitest.config.ts`
 * (e.g. `MOD_IMAGE_DAILY_BUDGET: "3000"`), not the general `string` a real
 * runtime value has — so a test that needs a *different* value (budget = 0
 * to force exhaustion) can't assign it directly. This is the one place that
 * widens the type back to `string` for that purpose.
 */
export function setTestEnvVar(key: keyof typeof env & string, value: string): void {
  (env as unknown as Record<string, string>)[key] = value;
}

export function freshClientIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

/** Headers for an authenticated request from a fresh synthetic client. Each
 * call gets its own `CF-Connecting-IP` so burst/daily rate limits never leak
 * between unrelated test cases — the primitives themselves (`checkAndBump`,
 * the `[[ratelimits]]` bindings) already have dedicated coverage in
 * `budget.test.ts`; these tests are about the route behavior around them. */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "CF-Connecting-IP": freshClientIp() };
}

/** Smallest possible byte sequences that pass `sniffImageType` as a JPEG —
 * not a real decodable image, which is fine, since nothing in this Worker
 * ever decodes photo bytes; it only sniffs, stores, and (in the real, not
 * mocked, pipeline) hands them to a vision model as an opaque blob. */
export function fakeJpegBytes(sizeBytes = 32): Uint8Array {
  const bytes = new Uint8Array(Math.max(sizeBytes, 3));
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

export function fakeFile(bytes: Uint8Array, name: string, type: string): File {
  // TS 5.9's DOM lib types `BlobPart` against `ArrayBufferView<ArrayBuffer>`
  // specifically, while `Uint8Array`'s own buffer is typed `ArrayBufferLike`
  // (it could in principle be backed by a `SharedArrayBuffer`) — a real
  // mismatch in general, but not one that applies to a `Uint8Array` we just
  // constructed ourselves two lines up in `fakeJpegBytes`.
  return new File([bytes as unknown as BlobPart], name, { type });
}

export interface UploadPhotoOptions {
  token: string;
  fullBytes?: Uint8Array;
  thumbBytes?: Uint8Array;
  width?: number;
  height?: number;
  blurhash?: string;
}

export async function uploadPhoto(options: UploadPhotoOptions): Promise<Response> {
  const form = new FormData();
  form.set("full", fakeFile(options.fullBytes ?? fakeJpegBytes(), "full.jpg", "image/jpeg"));
  form.set("thumb", fakeFile(options.thumbBytes ?? fakeJpegBytes(16), "thumb.jpg", "image/jpeg"));
  form.set("width", String(options.width ?? 800));
  form.set("height", String(options.height ?? 600));
  form.set("blurhash", options.blurhash ?? "LEHV6nWB2yk8pyo0adR*.7kCMdnj");

  return SELF.fetch("http://x/api/photos", {
    method: "PUT",
    headers: authHeaders(options.token),
    body: form,
  });
}

interface ApiOkBody<T> {
  ok: true;
  data: T;
}
interface ApiErrBody {
  ok: false;
  error: { code: string; message: string; retryAfter?: number };
}

export async function readOk<T>(res: Response): Promise<T> {
  const body = (await res.json()) as ApiOkBody<T> | ApiErrBody;
  if (!body.ok) {
    throw new Error(`expected ok:true, got error ${body.error.code}: ${body.error.message}`);
  }
  return body.data;
}

export async function readErr(res: Response): Promise<ApiErrBody["error"]> {
  const body = (await res.json()) as ApiOkBody<unknown> | ApiErrBody;
  if (body.ok) {
    throw new Error("expected ok:false, got a success response");
  }
  return body.error;
}

/** Directly seeds a `postal_codes` row, bypassing the real GeoNames seed
 * (not loaded in the test DB) — only `02144`/`M5V`/`SW1A` per the plan's M1
 * DoD need to resolve in tests. */
export async function seedPostalCode(row: {
  country: string;
  code: string;
  place_name: string;
  admin1: string | null;
  lat: number;
  lng: number;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO postal_codes (country, code, place_name, admin1, lat, lng) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(row.country, row.code, row.place_name, row.admin1, row.lat, row.lng)
    .run();
}

/**
 * `waitUntil()` work scheduled during a `SELF.fetch()` call (the moderation
 * pipeline, kicked off from `POST /api/listings`) keeps running after that
 * fetch's response comes back — `SELF` is a plain service-binding `Fetcher`,
 * so there's no `ExecutionContext` handle in the test to `waitOnExecutionContext`
 * the way you would calling the Worker's `fetch` export directly. It's still
 * running in the same isolate, though, so polling briefly for the expected
 * end state is reliable and fast in practice (MOCK_AI mode has no real
 * network latency) without coupling every test to pipeline internals.
 */
export async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 2000, intervalMs = 5): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForListingStatus(
  listingId: string,
  isDone: (status: string) => boolean,
): Promise<{ status: string; moderation_reason: string | null; published_at: number | null }> {
  return waitFor(async () => {
    const row = await env.DB.prepare("SELECT status, moderation_reason, published_at FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ status: string; moderation_reason: string | null; published_at: number | null }>();
    return row && isDone(row.status) ? row : undefined;
  });
}

export async function seedStandardPostalCodes(): Promise<void> {
  await seedPostalCode({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 42.3958, lng: -71.0967 });
  await seedPostalCode({ country: "CA", code: "M5V", place_name: "Toronto", admin1: "ON", lat: 43.6426, lng: -79.3871 });
  await seedPostalCode({ country: "GB", code: "SW1A", place_name: "London", admin1: null, lat: 51.5010, lng: -0.1416 });
}
