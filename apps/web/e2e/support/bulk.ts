/**
 * Estate bulk upload — the operator side an e2e spec has to stand in for.
 *
 * There is no self-serve path onto `/bulk`: `POST /api/admin/bulk/grants`
 * (`apps/api/src/routes/admin.ts`) mints admission for one `owner_id` by
 * hand, and an operator hands the resulting grant id to the giver out of
 * band (see that route's own header). This suite has no operator, so it has
 * to mint its own grants the same way, against the real admin API — never by
 * writing a `bulk_grants` row directly, for the same reason `support/api.ts`
 * never writes a `listings` row directly.
 *
 * The one piece that route needs and no HTTP response ever hands back is the
 * *owner id* behind an owner token: every owner-authed route authenticates
 * by the token itself and has no reason to echo the row's id. So this reads
 * it out of the same local D1 file `global-setup.mjs` already migrates for
 * this run, scoped by the token's own SHA-256 hash — `ownerAuth.ts`'s
 * `token_hash` — which is exact, unlike scanning the admin queue for a
 * matching title, which would race every other spec's listings on the same
 * shared local database.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { adminHeaders, freshClientIp, ownerHeaders } from "./api";
import { makePng } from "./png";

const API_DIR = path.resolve(__dirname, "../../../api");
/** Must match `playwright.config.ts`'s `STATE_DIR` and `global-setup.mjs`'s
 * — all three have to agree on where `wrangler dev --persist-to` put this
 * run's local D1 file. */
const STATE_DIR = path.join(API_DIR, ".wrangler", "e2e-state");

interface D1ExecuteResult {
  results: Array<Record<string, unknown>>;
}

const D1_QUERY_ATTEMPTS = 5;

/** Synchronous backoff for the retry below — `execFileSync` is already
 * blocking the event loop, so an async delay would buy nothing. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `wrangler d1 execute --local` opens its own connection to the same SQLite
 * file the running `wrangler dev` has open — observed to occasionally fail
 * outright (not just slow) under concurrent access from this suite's own
 * parallel workers each minting their own grant. Retried with backoff rather
 * than left to fail the whole test: this is a read against a table nothing
 * here is racing to *write* (an owner row, once created, is never deleted),
 * so a retry can only find the same answer, never a stale one.
 */
function ownerIdForToken(token: string): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  let lastError: unknown;
  for (let attempt = 1; attempt <= D1_QUERY_ATTEMPTS; attempt += 1) {
    try {
      const raw = execFileSync(
        "pnpm",
        [
          "exec",
          "wrangler",
          "d1",
          "execute",
          "keepsake-db",
          "--local",
          "--persist-to",
          STATE_DIR,
          "--json",
          "--command",
          `SELECT id FROM owners WHERE token_hash = '${tokenHash}'`,
        ],
        { cwd: API_DIR, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
      );
      const parsed = JSON.parse(raw) as D1ExecuteResult[];
      const id = parsed[0]?.results[0]?.id;
      if (typeof id !== "string") {
        throw new Error(
          "No `owners` row for this token yet — call ensureOwner() (or any create-if-missing endpoint, " +
            "e.g. a photo upload) before minting a grant for it.",
        );
      }
      return id;
    } catch (err) {
      lastError = err;
      if (attempt < D1_QUERY_ATTEMPTS) sleepSyncMs(200 * attempt);
    }
  }
  throw lastError;
}

/**
 * Establishes a real `owners` row for `ownerToken`, the same way a giver's
 * very first request does: `ownerAuth({ createIfMissing: true })` only fires
 * on `PUT /api/photos` and `POST /api/listings`, so this uploads a throwaway
 * photo rather than inventing a third path. The photo itself is never
 * referenced again.
 */
export async function ensureOwner(request: APIRequestContext, ownerToken: string): Promise<void> {
  await request.put("/api/photos", {
    headers: ownerHeaders(ownerToken),
    multipart: {
      full: { name: "full.png", mimeType: "image/png", buffer: makePng(400, 500, 1) },
      thumb: { name: "thumb.png", mimeType: "image/png", buffer: makePng(160, 200, 2) },
      width: "400",
      height: "500",
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    },
  });
}

export interface BulkGrant {
  id: string;
  owner_id: string;
  batch_id: string | null;
  items_remaining: number;
  photos_remaining: number;
  suggestions_remaining: number;
  expires_at: number;
}

/**
 * Mints a grant for `ownerToken`, exactly as an operator would by hand for
 * one pilot giver. Calls `ensureOwner` first — a grant minted for an
 * `owner_id` with no `owners` row would 500 the moment anything tried to
 * join against it.
 */
export async function mintBulkGrant(
  request: APIRequestContext,
  ownerToken: string,
  extra: { items?: number; photos?: number } = {},
): Promise<BulkGrant> {
  await ensureOwner(request, ownerToken);
  const ownerId = ownerIdForToken(ownerToken);
  const response = await request.post("/api/admin/bulk/grants", {
    headers: { ...adminHeaders(freshClientIp()), "Content-Type": "application/json" },
    data: { owner_id: ownerId, ...extra },
  });
  const body = (await response.json()) as { ok: boolean; data?: BulkGrant; error?: unknown };
  if (!body.ok || !body.data) {
    throw new Error(`POST /api/admin/bulk/grants -> ${response.status()} ${JSON.stringify(body.error ?? body)}`);
  }
  return body.data;
}
