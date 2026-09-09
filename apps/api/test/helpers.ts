/** Shared fixtures for the M1 route/pipeline tests: synthetic owner tokens,
 * minimal-but-valid image bytes, and small request-building helpers. Kept
 * out of any one test file since photos/listings/moderation tests all need
 * the same building blocks. */
import { encode as encodeJpeg } from "jpeg-js";
import { env, SELF } from "cloudflare:test";
import { ulid } from "../src/lib/ids.js";
import type { RateLimitBindingName } from "../src/middleware/rateLimit.js";

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

let requesterEmailCounter = 0;

/**
 * A requester address no other test has used, for the same reason
 * `freshClientIp` exists — except that the limit this one keeps out of the
 * way is keyed by the *recipient*.
 *
 * Issue #188 added a per-address daily ceiling on the "was this you?"
 * confirmation (three, `REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET`). A suite where
 * every test asks as `requester@keepsake.ing` shares one counter, so the
 * fourth test in a file silently stops receiving mail and fails somewhere far
 * from the cause. The ceiling itself is proved deliberately, with an address
 * of its own, in `requestConfirm.test.ts`.
 */
export function freshRequesterEmail(): string {
  requesterEmailCounter += 1;
  return `requester-${requesterEmailCounter}@keepsake.ing`;
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

/**
 * A JPEG whose header actually declares `width`x`height`, so
 * `sniffImageDimensions` can read it.
 *
 * An APP0 (JFIF) segment is written *before* the SOF0 on purpose: every real
 * camera JPEG puts kilobytes of JFIF/EXIF ahead of the frame header, so a
 * fixture without one would let a parser that reads a fixed offset pass while
 * failing on every actual photo. This one only passes if the marker walk
 * really walks.
 */
export function fakeJpegWithSof(width: number, height: number, sizeBytes = 64): Uint8Array {
  const header = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length 17, 8-bit precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, // 3 components
  ];
  const bytes = new Uint8Array(Math.max(sizeBytes, header.length));
  bytes.set(header, 0);
  return bytes;
}

/**
 * A PNG whose IHDR declares `width`x`height`. No IDAT and no valid CRC —
 * `sniffImageDimensions` reads only the signature and the IHDR fields, and a
 * fixture that carried real compressed pixel data would be testing zlib.
 */
export function fakePngBytes(width: number, height: number, sizeBytes = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(sizeBytes, 26));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
  return bytes;
}

/**
 * A real, decodable baseline JPEG of `width`x`height`.
 *
 * `fakeJpegBytes` and `fakeJpegWithSof` are headers followed by zeros — which
 * is all `sniffImageDimensions` and the upload path ever look at, and is
 * exactly why they exist. The share card is different: resvg genuinely
 * decodes the cover photo, and correctly refuses a fixture that only *looks*
 * like a JPEG. Encoding one here (with the same `jpeg-js` the card's renderer
 * uses) keeps the repo free of a base64 blob and lets a test pick whatever
 * dimensions it needs to exercise `pickVariant`'s thumb-vs-full rule.
 *
 * The pixels are a gradient rather than one flat colour so a card rendered
 * from this is visibly a photo in any screenshot a failing run leaves behind.
 */
export function realJpegBytes(width = 16, height = 16): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = (x * 16) & 0xff;
      data[at + 1] = (y * 16) & 0xff;
      data[at + 2] = ((x + y) * 8) & 0xff;
      data[at + 3] = 255;
    }
  }
  return new Uint8Array(encodeJpeg({ data, width, height }, 80).data);
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

/**
 * Uploads a photo the way an honest client does: **the same bytes for both
 * variants**, standing in for a `full` and a `thumb` produced from one
 * source image.
 *
 * This helper used to default `full` to `fakeJpegBytes()` (32 bytes) and
 * `thumb` to `fakeJpegBytes(16)` — two byte sequences no single source
 * image could have produced — so every test in this suite had been
 * demonstrating #161's attack shape by accident, with nothing objecting.
 * The default now models a real client; a test that wants mismatched
 * variants passes `fullBytes`/`thumbBytes` explicitly and is saying so on
 * purpose (see `moderationVariants.test.ts`).
 *
 * Note what this helper still cannot do, and what the server therefore
 * still cannot check: nothing here or in `PUT /api/photos` decodes an
 * image, so "these two files came from one source" is not verifiable
 * server-side. That is why #161 is fixed by moderating both variants
 * rather than by rejecting mismatched ones.
 */
export async function uploadPhoto(options: UploadPhotoOptions): Promise<Response> {
  const form = new FormData();
  const fullBytes = options.fullBytes ?? fakeJpegBytes();
  form.set("full", fakeFile(fullBytes, "full.jpg", "image/jpeg"));
  form.set("thumb", fakeFile(options.thumbBytes ?? fullBytes, "thumb.jpg", "image/jpeg"));
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

/** Inserts an `owners` row directly, bypassing `ownerAuth`'s upsert-on-first-
 * write path — for feed tests that need many listings and don't care whose
 * they are. */
export async function insertOwner(): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, `test-hash-${id}`, now, now)
    .run();
  return id;
}

export interface InsertApprovedListingOptions {
  ownerId: string;
  title?: string;
  story?: string;
  category?: string;
  country?: string;
  postalCode?: string;
  placeName?: string;
  admin1?: string | null;
  lat?: number;
  lng?: number;
  publishedAt?: number;
}

/** Inserts a `listings` row directly at `status='approved'`, skipping the
 * owner-auth/photo-upload/moderation round trip entirely — for feed tests
 * that need dozens of approved listings fast, where what's under test is
 * pagination/filtering/search, not the create-and-moderate flow already
 * covered by `listings.test.ts`/`moderation.test.ts`. */
export async function insertApprovedListing(options: InsertApprovedListingOptions): Promise<string> {
  const id = ulid();
  const now = options.publishedAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO listings
      (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
       status, version, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?, ?)`,
  )
    .bind(
      id,
      options.ownerId,
      options.title ?? "A quiet teacup",
      // Deliberately doesn't contain any FTS test's search term (e.g.
      // "grandmother") — feed.test.ts's search-mode tests share this file's
      // D1 state with every other test in the same describe block, and a
      // default fixture word colliding with a search assertion would be a
      // flaky, hard-to-diagnose false failure.
      options.story ?? "This belonged to a dear friend of the family, and I'd love for it to find a new home.",
      options.category ?? "home_kitchen",
      options.country ?? "US",
      options.postalCode ?? "02144",
      options.placeName ?? "Somerville",
      options.admin1 ?? "MA",
      options.lat ?? 42.3958,
      options.lng ?? -71.0967,
      now,
      now,
      now,
    )
    .run();
  return id;
}

export async function seedStandardPostalCodes(): Promise<void> {
  await seedPostalCode({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 42.3958, lng: -71.0967 });
  await seedPostalCode({ country: "CA", code: "M5V", place_name: "Toronto", admin1: "ON", lat: 43.6426, lng: -79.3871 });
  await seedPostalCode({ country: "GB", code: "SW1A", place_name: "London", admin1: null, lat: 51.5010, lng: -0.1416 });
  // For the M2 geo-radius DoD: 25 mi from 02144 (Somerville) includes 02139
  // (Cambridge, ~1.7 mi away) and excludes 01608 (Worcester, ~37 mi away).
  await seedPostalCode({ country: "US", code: "02139", place_name: "Cambridge", admin1: "MA", lat: 42.3736, lng: -71.1097 });
  await seedPostalCode({ country: "US", code: "01608", place_name: "Worcester", admin1: "MA", lat: 42.2626, lng: -71.8023 });
}

// ---------------------------------------------------------------------------
// Email fakes (M3): every `sendMail()` call site reads `env.EMAIL`/
// `env.RESEND_API_KEY` through `src/env.ts`'s `emailProviderName`, so
// installing a fake `.send()` here is the one seam that works regardless of
// which provider a test's `EMAIL_PROVIDER` var is pointed at.
// ---------------------------------------------------------------------------

export interface CapturedEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

interface FakeSendEmailMessage {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** Replaces `env.EMAIL` with a fake `.send()` that records every message
 * instead of attempting a real send, and returns the array it appends to —
 * call this in a test's `beforeEach`/at the top of a test, then assert on
 * the returned array's contents. */
export function installFakeEmail(): CapturedEmail[] {
  const sent: CapturedEmail[] = [];
  const fakeEmail = {
    send: async (message: FakeSendEmailMessage) => {
      sent.push({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html ?? "",
        text: message.text ?? "",
        ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
        ...(message.headers !== undefined ? { headers: message.headers } : {}),
      });
      return { messageId: "fake-message-id" };
    },
  };
  (env as unknown as Record<string, unknown>).EMAIL = fakeEmail;
  return sent;
}

/** Removes the fake installed by `installFakeEmail`, restoring the
 * "binding missing" stub-log path — used by tests asserting an owner
 * *without* a verified email gets no notification at all. */
export function removeFakeEmail(): void {
  delete (env as unknown as Record<string, unknown>).EMAIL;
}

// ---------------------------------------------------------------------------
// Rate-limit binding fakes.
//
// The real `[[ratelimits]]` bindings do work under vitest-pool-workers, so a
// test *can* prove a limiter fires by making limit+1 requests — and
// `adminAuth.test.ts` does exactly that for `RL_ADMIN`, because the count is
// the whole point of that finding. But a limiter's *position in the
// middleware chain* is a different property, and proving it by exhausting a
// 300/60s binding would be slow and would leak counted requests into every
// other test sharing the isolate. Swapping the binding for one that denies
// immediately isolates the ordering question: if the limiter runs first, the
// very first request is a 429 and nothing behind it (auth, an `owners`
// insert) ever executes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Vectorize binding fake (issue #38).
//
// `env.VECTORIZE` has no local emulator (same as `env.AI` — both are
// `V4RemoteBinding`s in miniflare's own types, confirmed by the "Vectorize
// Index bindings do not support local development" warning `vitest run`
// prints), so unlike D1/R2/KV it would otherwise make a real network call
// to Cloudflare on every listing create/edit/delete a test drives — slow,
// flaky, and (in CI, which sets no CLOUDFLARE_API_TOKEN for the test job)
// unauthenticated. `test/setup.ts` installs this by default for every test
// file, the same way `TEST_MIGRATIONS` is applied for every file, so a test
// that never mentions Vectorize still can't reach the real index by
// accident — only a test that explicitly wants deterministic search
// behavior needs to call this itself (for a fresh, empty store) or read the
// instance back off `env.VECTORIZE`.
// ---------------------------------------------------------------------------

interface FakeVector {
  id: string;
  values: number[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** In-memory stand-in for the real `VectorizeIndex` shape this Worker
 * actually calls (`upsert`/`deleteByIds`/`query` — see `src/search/vectorize.ts`),
 * scoring `query()` by real cosine similarity so a test can assert on
 * ranking, not just membership. */
export class FakeVectorizeIndex {
  private readonly store = new Map<string, number[]>();

  async upsert(vectors: FakeVector[]): Promise<{ ids: string[]; count: number }> {
    for (const vector of vectors) this.store.set(vector.id, vector.values);
    return { ids: vectors.map((vector) => vector.id), count: vectors.length };
  }

  async deleteByIds(ids: string[]): Promise<{ ids: string[]; count: number }> {
    let count = 0;
    for (const id of ids) {
      if (this.store.delete(id)) count += 1;
    }
    return { ids, count };
  }

  async query(vector: number[], options?: { topK?: number }): Promise<{ matches: { id: string; score: number }[]; count: number }> {
    const topK = options?.topK ?? 10;
    const scored = Array.from(this.store.entries())
      .map(([id, values]) => ({ id, score: cosineSimilarity(vector, values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { matches: scored, count: scored.length };
  }

  /** Test-only inspection, not part of the real `VectorizeIndex` surface —
   * lets a test assert a listing's vector was (or wasn't) written without
   * going back through a query's similarity ranking. */
  has(id: string): boolean {
    return this.store.has(id);
  }

  valuesFor(id: string): number[] | undefined {
    return this.store.get(id);
  }
}

/** Installs a fresh `FakeVectorizeIndex` as `env.VECTORIZE` and returns it.
 * Safe to call again mid-test (e.g. to reset to an empty store and prove
 * the "Vectorize answered but had nothing useful" fallback) — each call
 * replaces the binding with a brand new, empty instance. */
export function installFakeVectorize(): FakeVectorizeIndex {
  const fake = new FakeVectorizeIndex();
  (env as unknown as Record<string, unknown>).VECTORIZE = fake;
  return fake;
}

/** Removes `env.VECTORIZE` entirely — for the "binding missing" fallback
 * case, distinct from "binding present but empty" (`installFakeVectorize()`
 * with nothing upserted). */
export function removeFakeVectorize(): void {
  delete (env as unknown as Record<string, unknown>).VECTORIZE;
}

/** Replaces a `[[ratelimits]]` binding with one that denies every call, and
 * returns a restore function. Same `env`-mutation seam as `installFakeEmail`:
 * `SELF` and this test share one `env` object. */
export function installDenyingRateLimiter(name: RateLimitBindingName): () => void {
  const bindings = env as unknown as Record<string, unknown>;
  const original = bindings[name];
  bindings[name] = { limit: async () => ({ success: false }) };
  return () => {
    bindings[name] = original;
  };
}

/**
 * Replaces a `[[ratelimits]]` binding with one that allows exactly `limit`
 * calls per key and denies every call after that, recording each key it was
 * handed.
 *
 * Issue #116. The admin brute-force test used to exhaust the *real* `RL_ADMIN`
 * binding with 400 sequential requests, because the audit that found the bug
 * measured it that way. Two things made that unreliable, and neither is about
 * the code under test: Cloudflare documents these bindings as "permissive,
 * eventually consistent, and intentionally designed to not be used as an
 * accurate accounting system" (measured here at ~2.6x overshoot), and 400
 * awaited round trips is real wall-clock work whose duration depends on how
 * busy the machine is. Reproduced deliberately for #116: with 24 busy loops on
 * a 4-core container the test hit its own 30s timeout, and it is the same test
 * two sessions saw fail on unmodified `main`.
 *
 * A test that fails when the host is loaded cannot distinguish "the guard
 * works" from "the machine was fast today", so the guard is asserted against a
 * limiter this repo controls instead — the same trade `readRateLimit.test.ts`
 * already makes with `installDenyingRateLimiter`, and for the same measured
 * reason. What is gained is a stronger claim than the real binding could ever
 * support: *every* request must reach the limiter, all under one key, with the
 * refusal landing on exactly the call after the limit.
 */
export function installCountingRateLimiter(
  name: RateLimitBindingName,
  options: { limit: number },
): { keys: string[]; restore: () => void } {
  const bindings = env as unknown as Record<string, unknown>;
  const original = bindings[name];
  const keys: string[] = [];
  const seen = new Map<string, number>();
  bindings[name] = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      const used = (seen.get(key) ?? 0) + 1;
      seen.set(key, used);
      return { success: used <= options.limit };
    },
  };
  return {
    keys,
    restore: () => {
      bindings[name] = original;
    },
  };
}

/** Replaces a `[[ratelimits]]` binding with one that allows every call and
 * records the `key` it was handed, so a test can assert on *what* `burst()`
 * keys the limiter by — not just that it fired. Issue #87: the key used to be
 * a bare SHA-256 of the caller's address, a never-rotating identifier, and no
 * test could see it because nothing ever looked at the argument. */
export function installRecordingRateLimiter(name: RateLimitBindingName): { keys: string[]; restore: () => void } {
  const bindings = env as unknown as Record<string, unknown>;
  const original = bindings[name];
  const keys: string[] = [];
  bindings[name] = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: true };
    },
  };
  return {
    keys,
    restore: () => {
      bindings[name] = original;
    },
  };
}

/**
 * Issue #159. The single `tail_deliveries` row the Tail Worker stamps on
 * every delivery — the evidence that a tail consumer is attached at all, and
 * what `observatory/errorEvents.ts` refuses to report a feed without. Seeded
 * directly here so a test can set up the "pipeline is live" state without
 * driving a whole delivery through `persistTailEvents`.
 */
export async function seedTailDelivery(at: number = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tail_deliveries (id, first_delivery_at, last_delivery_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_delivery_at = excluded.last_delivery_at`,
  )
    .bind(at, at)
    .run();
}

export interface InsertErrorEventOptions {
  observedAt: number;
  receivedAt?: number;
  level?: "error" | "warning";
  kind?: string;
  message?: string;
  scriptName?: string | null;
  requestId?: string | null;
}

/**
 * An `error_events` row, inserted directly rather than through the Tail
 * Worker's own writer — for the tests that need a row at a chosen age (the
 * window and retention cases), where driving a real delivery would mean
 * lying to `Date.now()` instead.
 */
export async function insertErrorEvent(options: InsertErrorEventOptions): Promise<string> {
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO error_events
       (id, observed_at, received_at, script_name, level, kind, message, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      options.observedAt,
      options.receivedAt ?? options.observedAt,
      options.scriptName ?? "keepsake-test",
      options.level ?? "error",
      options.kind ?? "capture",
      options.message ?? "something went wrong",
      options.requestId ?? null,
    )
    .run();
  return id;
}
