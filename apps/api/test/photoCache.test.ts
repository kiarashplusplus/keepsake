/**
 * Issue #94 — `purgePhotoCache` used to be `caches.default.delete()` alone,
 * which reaches only the colo executing the request. The zone-level Purge
 * Cache API is what reaches every colo, and this file is the only place that
 * can say anything about it: the multi-colo behaviour itself is unprovable
 * from a test runner (it needs a real zone, a real token, and traffic
 * arriving at two different data centers), so what is proved here is the
 * next thing down — that the *exact* request the code sends is the request
 * Cloudflare documents, and that every failure mode of that request is
 * contained.
 *
 * That split matters. A test asserting only "fetch was called" would pass
 * against a request Cloudflare rejects — wrong path, wrong verb, missing
 * credential, one variant URL silently dropped from the body — and the purge
 * would fail in production while CI stayed green. So the happy-path test
 * pins the method, the URL, the `Authorization` header and both variant URLs
 * in the JSON body, and the failure tests pin the two properties the call
 * sites depend on: it never throws, and it never goes quiet.
 *
 * The no-config case gets its own tests because it is the common case, not
 * an edge: local `wrangler dev`, `vitest`, Playwright and any preview
 * deployed without the secret all run without a purge token, and "makes no
 * HTTP call at all" is the behaviour that keeps them working.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { purgePhotoCache } from "../src/lib/photoCache.js";
import {
  authHeaders,
  freshOwnerToken,
  readOk,
  seedStandardPostalCodes,
  setTestEnvVar,
  uploadPhoto,
  waitFor,
  waitForListingStatus,
} from "./helpers.js";

const TEST_ZONE_ID = "dcc1fb09eeeba27a343fc1d98aff9094";
const TEST_PURGE_TOKEN = "cf-purge-token-for-tests";
const PURGE_ENDPOINT = `https://api.cloudflare.com/client/v4/zones/${TEST_ZONE_ID}/purge_cache`;

/** `env.SITE_URL` in the test runtime — see `vitest.config.ts`'s pinned
 * bindings. Read rather than hardcoded so the assertions below stay true if
 * that pin ever changes. */
const SITE_URL = env.SITE_URL as string;

interface CapturedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

function headersToObject(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  for (const [key, value] of new Headers(init)) out[key] = value;
  return out;
}

interface FakeCloudflare {
  /** Every `fetch` the isolate made while the stub was installed. */
  all: CapturedCall[];
  /**
   * Just the ones aimed at Cloudflare's API. The route-level test below
   * drives a whole create-moderate-delete flow through `SELF`, so asserting
   * on a raw call count would couple this file to whatever else that flow
   * might one day fetch. A getter, not a snapshot: `all` is appended to as
   * the isolate runs.
   */
  readonly purges: CapturedCall[];
}

/** Stubs global `fetch` and records every call. */
function installFakeCloudflare(respond: () => Response): FakeCloudflare {
  const all: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      all.push({
        url: String(input),
        method: init?.method,
        headers: headersToObject(init?.headers as HeadersInit | undefined),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return respond();
    }),
  );
  return {
    all,
    get purges() {
      return all.filter((call) => call.url.startsWith("https://api.cloudflare.com/"));
    },
  };
}

/** The single recorded purge, or a failure naming what was recorded instead
 * — `noUncheckedIndexedAccess` makes `purges[0]` possibly-undefined, and a
 * bare `!` would turn "no purge was sent" into a confusing property error. */
function onlyPurge(fake: FakeCloudflare): CapturedCall {
  const [call] = fake.purges;
  if (!call) throw new Error(`expected one Cloudflare purge, saw: ${JSON.stringify(fake.all.map((c) => c.url))}`);
  return call;
}

/** The `files` list out of a recorded purge body. */
function purgedFiles(call: CapturedCall): string[] {
  return (JSON.parse(call.body) as { files: string[] }).files;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Cloudflare's real success envelope for this endpoint. */
function purgeAccepted(): Response {
  return jsonResponse({ success: true, errors: [], messages: [], result: { id: TEST_ZONE_ID } });
}

function configureZonePurge(): void {
  setTestEnvVar("CF_ZONE_ID", TEST_ZONE_ID);
  setTestEnvVar("CF_CACHE_PURGE_TOKEN", TEST_PURGE_TOKEN);
}

afterEach(() => {
  vi.unstubAllGlobals();
  // `CF_ZONE_ID` is `""` in the top-level `[vars]` block wrangler.toml hands
  // the test runtime; `CF_CACHE_PURGE_TOKEN` is a secret and is simply
  // absent. Restore both shapes so one test's configuration can't leak into
  // the next file-shared `env`.
  setTestEnvVar("CF_ZONE_ID", "");
  delete (env as unknown as Record<string, unknown>).CF_CACHE_PURGE_TOKEN;
});

describe("issue #94: zone-level purge request shape", () => {
  it("POSTs both variant URLs to the zone purge endpoint with a bearer token", async () => {
    configureZonePurge();
    const fake = installFakeCloudflare(purgeAccepted);

    await purgePhotoCache(env, "photo-abc");

    expect(fake.purges).toHaveLength(1);
    const call = onlyPurge(fake);

    // The path. A purge sent to the wrong zone, or to the account-level
    // endpoint, is a 404 Cloudflare answers cheerfully with JSON.
    expect(call.url).toBe(PURGE_ENDPOINT);
    expect(call.method).toBe("POST");

    // The credential. Cloudflare answers an unauthenticated purge with 400,
    // not 401, so a missing header is easy to ship and hard to notice.
    expect(call.headers.authorization).toBe(`Bearer ${TEST_PURGE_TOKEN}`);
    expect(call.headers["content-type"]).toBe("application/json");

    // The payload. `files` must list *both* variants: a thumbnail is a
    // recognizable photo of a stranger's keepsake, so purging only `full`
    // would leave the visible half of the leak in place at every colo.
    expect(purgedFiles(call)).toEqual([`${SITE_URL}/i/photo-abc/full`, `${SITE_URL}/i/photo-abc/thumb`]);
  });

  it("sends one request per photo, not one per variant", async () => {
    // The terminal-photo sweep purges up to 100 photos per batch. Two calls
    // each would double the load against a rate-limited API for nothing —
    // `files` takes a list.
    configureZonePurge();
    const fake = installFakeCloudflare(purgeAccepted);

    await purgePhotoCache(env, "photo-one");
    await purgePhotoCache(env, "photo-two");

    expect(fake.purges).toHaveLength(2);
    expect(fake.purges.map((call) => purgedFiles(call).length)).toEqual([2, 2]);
  });
});

describe("issue #94: unconfigured is a silent no-op", () => {
  it("makes no HTTP call when neither the zone id nor the token is set", async () => {
    const fake = installFakeCloudflare(purgeAccepted);

    // No `configureZonePurge()` — this is exactly the state local dev, the
    // e2e suite and an un-secreted preview run in.
    await purgePhotoCache(env, "photo-unconfigured");

    expect(fake.all).toHaveLength(0);
  });

  it("makes no HTTP call when the zone id is set but the token is not", async () => {
    // The state this repo ships in until Kiarash mints the token: wrangler
    // .toml carries `CF_ZONE_ID` for preview and production, and neither
    // Worker has the secret yet. Half-configured must be as inert as
    // unconfigured — an unauthenticated purge is a guaranteed 400 on every
    // single delete.
    setTestEnvVar("CF_ZONE_ID", TEST_ZONE_ID);
    const fake = installFakeCloudflare(purgeAccepted);

    await purgePhotoCache(env, "photo-no-token");

    expect(fake.all).toHaveLength(0);
  });

  it("makes no HTTP call when the token is set but the zone id is not", async () => {
    setTestEnvVar("CF_CACHE_PURGE_TOKEN", TEST_PURGE_TOKEN);
    const fake = installFakeCloudflare(purgeAccepted);

    await purgePhotoCache(env, "photo-no-zone");

    expect(fake.all).toHaveLength(0);
  });

  it("treats a whitespace-only zone id or token as unset", async () => {
    // `wrangler secret put` reading from a file that ends in a newline is a
    // real way to end up with a token that is truthy and useless.
    setTestEnvVar("CF_ZONE_ID", "  ");
    setTestEnvVar("CF_CACHE_PURGE_TOKEN", "\n");
    const fake = installFakeCloudflare(purgeAccepted);

    await purgePhotoCache(env, "photo-blank");

    expect(fake.all).toHaveLength(0);
  });
});

describe("issue #94: a failing purge never breaks the caller", () => {
  it("resolves, and logs a warning, when Cloudflare answers 500", async () => {
    configureZonePurge();
    const fake = installFakeCloudflare(() =>
      jsonResponse({ success: false, errors: [{ code: 1000, message: "Internal error" }] }, 500),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(purgePhotoCache(env, "photo-500")).resolves.toBeUndefined();

    expect(fake.purges).toHaveLength(1);
    // Not swallowed: `@keepsake/observability/capture`'s `captureMessage`
    // writes warnings through `console.warn`, which Workers Logs ingests.
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("Cloudflare zone cache purge failed");
    expect(logged).toContain("photo-500");
    warn.mockRestore();
  });

  it("resolves, and logs, when Cloudflare returns 200 with success:false", async () => {
    // The v4 envelope, not the status line, is what says a purge landed.
    configureZonePurge();
    installFakeCloudflare(() => jsonResponse({ success: false, errors: [{ code: 1012, message: "Bad zone" }] }, 200));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(purgePhotoCache(env, "photo-envelope")).resolves.toBeUndefined();

    expect(JSON.stringify(warn.mock.calls)).toContain("Cloudflare zone cache purge failed");
    warn.mockRestore();
  });

  it("resolves, and logs, when the API is unreachable", async () => {
    configureZonePurge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network connection lost.");
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(purgePhotoCache(env, "photo-offline")).resolves.toBeUndefined();

    expect(JSON.stringify(error.mock.calls)).toContain("Network connection lost.");
    error.mockRestore();
  });

  it("still deletes the listing when the zone purge fails", async () => {
    // The property that actually matters to a person: the delete they asked
    // for completes even though Cloudflare's API is down. Driven through the
    // real route, not the library function, because `listings.ts` is where a
    // rejected purge would surface.
    await seedStandardPostalCodes();
    configureZonePurge();
    const fake = installFakeCloudflare(() =>
      jsonResponse({ success: false, errors: [{ code: 1000, message: "Internal error" }] }, 500),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
    const created = await readOk<OwnerListing>(
      await SELF.fetch("http://x/api/listings", {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "A quiet teacup",
          story: "This belonged to a dear friend of the family, and I'd love for it to find a new home.",
          category: "home_kitchen",
          country: "US",
          postal_code: "02144",
          date_of_birth: "1990-01-01",
          photo_ids: [photo.id],
        }),
      }),
    );
    await waitForListingStatus(created.id, (status) => status === "approved");

    const deleteRes = await SELF.fetch(`http://x/api/listings/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    expect(deleteRes.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM listings WHERE id = ?").bind(created.id).first();
    expect(row).toBeNull();

    // Non-vacuous: the purge really was attempted (and really did fail) on
    // this delete. It runs in `waitUntil`, so it can land after the response.
    const purge = await waitFor(async () => fake.purges[0]);
    expect(purge.url).toBe(PURGE_ENDPOINT);
    expect(purgedFiles(purge)).toEqual([`${SITE_URL}/i/${photo.id}/full`, `${SITE_URL}/i/${photo.id}/thumb`]);
    warn.mockRestore();
  });
});
