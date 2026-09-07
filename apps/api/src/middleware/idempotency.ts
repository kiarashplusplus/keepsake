/**
 * Optional `X-Idempotency-Key` support for `POST /api/listings` (and any
 * later write route that mounts this). A retried submit from a flaky mobile
 * connection replays the first response instead of creating a second
 * listing. Scoped per-caller: an owner's key and a stranger's key with the
 * same string never collide, and the KV key never holds a raw IP (only its
 * digest), matching the no-raw-IPs rule everywhere else in this Worker.
 *
 * That digest rotates daily since issue #87 (`dailyIpDigest`), like every
 * other address digest here. The only behavioural cost is a replay whose
 * retry crosses midnight UTC: an anonymous caller's cached response becomes
 * unreachable and the write happens again. Today that is unreachable in
 * practice — the sole route mounting this middleware
 * (`POST /api/listings`) runs `ownerAuth({ createIfMissing: true })` first,
 * so `owner` is always set and the IP branch below is the fallback for a
 * mount that doesn't exist yet. Worth knowing before adding one.
 */
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../env.js";
import type { OwnerRow } from "./ownerAuth.js";
import { dailyIpDigest } from "../lib/digest.js";
import { clientIPFrom } from "../moderation/budget.js";

type IdempotencyCtx = Context<{ Bindings: Env; Variables: { owner?: OwnerRow } }>;

const MAX_KEY_LENGTH = 128;
const TTL_SECONDS = 24 * 60 * 60;

interface StoredResponse {
  status: number;
  body: unknown;
}

export function idempotency() {
  return async (c: IdempotencyCtx, next: Next) => {
    const key = c.req.header("X-Idempotency-Key");
    if (!key || key.length > MAX_KEY_LENGTH) {
      await next();
      return;
    }

    const owner = c.get("owner");
    const scope = owner ? owner.id : await dailyIpDigest(clientIPFrom(c.req.raw));
    const kvKey = `idem:${scope}:${key}`;

    const cached = await c.env.KV.get<StoredResponse>(kvKey, "json");
    if (cached) {
      c.header("X-Idempotent-Replay", "1");
      return c.json(cached.body, cached.status as ContentfulStatusCode);
    }

    await next();

    // Only successful writes are worth replaying verbatim for 24h; a
    // validation error or a transient 5xx should be retryable as-is, not
    // frozen into the cache.
    if (c.res.status >= 200 && c.res.status < 300) {
      let body: unknown;
      try {
        body = await c.res.clone().json();
      } catch {
        return;
      }
      const stored: StoredResponse = { status: c.res.status, body };
      await c.env.KV.put(kvKey, JSON.stringify(stored), { expirationTtl: TTL_SECONDS });
    }
  };
}
