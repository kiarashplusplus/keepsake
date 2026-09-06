/**
 * KV-based daily budget counters.
 *
 * Ported from Bayan `worker/src/budget.ts`. That Worker rations Workers AI
 * calls behind one unauthenticated endpoint; this one rations six different
 * things — three AI calls (`mod_text`, `mod_image`, `suggest`) and three
 * write endpoints that don't touch AI at all (`listing`, `request`,
 * `upload`) — because Keepsake has no accounts either, so the only caller
 * identity available is an IP address.
 *
 * `suggest` (AI autofill, `POST /api/photos/:id/suggest`) is checked with a
 * real global `dailyLimit`, the same way `mod_text`/`mod_image` are checked
 * directly from `moderation/pipeline.ts` — unlike `listing`/`request`/
 * `upload`, whose global side is deliberately unbounded (see
 * `middleware/rateLimit.ts`'s `EFFECTIVELY_UNLIMITED`) because only their
 * per-IP ceiling is meant to bite. `suggest` gets its own counter rather than
 * sharing `mod_image`'s: an exhausted image-moderation budget leaves
 * listings `pending` until midnight UTC (`pipeline.ts`, the image budget
 * gate), so a burst of autofill calls must never be able to spend the budget
 * a real listing needs to finish moderating.
 *
 * Global key format:    "budget:<kind>:YYYY-MM-DD"
 * Per-client key format: "budget:ip:<kind>:<daily-digest>:YYYY-MM-DD"
 *
 * Value: string-encoded integer count. TTL: 48 hours (auto-cleanup across
 * timezones without a cron of its own).
 *
 * The per-client key holds a digest of the address and the day, never the
 * address itself. Counting requests per caller does not require knowing who
 * the caller is, and the privacy page promises no identifier is stored — a KV
 * namespace full of raw IPs would make that false. The digest is not a promise
 * of anonymity (the IPv4 space is small enough to enumerate against a known
 * day); it is minimization, and it means the stored key stops meaning anything
 * the moment the day rolls over.
 *
 * Every endpoint here is unauthenticated (no accounts, per the plan), so the
 * global counter alone would let one caller drain a whole day's ceiling for
 * everyone. The per-IP counter is a cheap floor under that: it does not stop
 * an attacker with many addresses, but it does stop one client — or one buggy
 * retry loop — from taking a feature down for every other giver until a real
 * client credential exists.
 *
 * Both ceilings are runaway protection and nothing else. Keepsake is free and
 * moderation runs on Cloudflare's own Workers AI allocation, so the numbers
 * are set far past anything a person posting a few keepsakes would reach —
 * the only thing they should ever catch is a program.
 *
 * The per-IP ceiling in particular is a blunt instrument, worth naming as one:
 * an address is not a person. A household is one address; a mobile carrier
 * puts thousands of subscribers behind one CGNAT address. A per-IP number
 * that sounds generous for one giver is shared by everyone behind that
 * address, which is how a cap meant for scrapers ends up refusing families.
 * Per-install limiting needs a client credential; until then this is
 * deliberately loose, and the global counter is the ceiling that means
 * anything.
 */

const TTL_SECONDS = 172_800; // 48 hours

/** The six things this Worker rations per calendar day. */
export type BudgetKind = "mod_text" | "mod_image" | "suggest" | "listing" | "request" | "upload";

export interface CheckAndBumpOptions {
  kind: BudgetKind;
  /** Caller address from `CF-Connecting-IP`; omitted callers share one bucket. */
  clientIP?: string;
  /** Global ceiling for `kind` today. */
  dailyLimit: number;
  /** Per-IP ceiling for `kind` today. Omitted disables the per-IP check. */
  ipDailyLimit?: number;
}

export interface CheckAndBumpResult {
  allowed: boolean;
  /** Seconds until the ceiling resets (midnight UTC), only set when denied. */
  retryAfter?: number;
}

/**
 * Both counters are read-then-write, not atomic: two requests that interleave
 * between the read and the put record a single increment. We accept that
 * drift. KV has no atomic add, and the fix is a Durable Object per counter,
 * which is a larger change than the ceiling warrants — the undercount is
 * bounded by the number of genuinely concurrent requests, which for this
 * traffic is a handful, and it errs towards serving givers rather than
 * refusing them.
 */

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function todayKey(kind: BudgetKind): string {
  return `budget:${kind}:${todayISO()}`;
}

/**
 * SHA-256 over the day and the address, truncated to 128 bits and hex-encoded.
 *
 * The day is inside the digest as well as in the key so the same caller gets
 * an unrelated digest tomorrow: two days of counters cannot be joined into a
 * history of one address, which is the only thing this data could otherwise
 * be turned into.
 */
async function clientDigest(clientIP: string): Promise<string> {
  const input = new TextEncoder().encode(`${todayISO()}:${clientIP}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The KV key holding today's count for one caller and one kind. Exported so
 * tests address the same key the Worker does rather than rebuilding the
 * layout — the last version of that duplication is what let a raw IP sit in
 * the store with the tests asserting it belonged there.
 */
export async function todayIPKey(kind: BudgetKind, clientIP: string): Promise<string> {
  const digest = await clientDigest(clientIP);
  return `budget:ip:${kind}:${digest}:${todayISO()}`;
}

async function readCount(kv: KVNamespace, key: string): Promise<number> {
  const val = await kv.get(key);
  return val ? parseInt(val, 10) : 0;
}

async function bumpCount(kv: KVNamespace, key: string): Promise<number> {
  const next = (await readCount(kv, key)) + 1;
  await kv.put(key, String(next), { expirationTtl: TTL_SECONDS });
  return next;
}

/** Calculate seconds until midnight UTC (for a Retry-After header). */
export function secondsUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  midnight.setUTCHours(0, 0, 0, 0);
  return Math.max(1, Math.min(86_400, Math.ceil((midnight.getTime() - now.getTime()) / 1000)));
}

/**
 * Identify the caller for budgeting purposes.
 *
 * Cloudflare sets CF-Connecting-IP on every request that reaches the Worker,
 * so the fallback only fires for traffic that never passed through the edge
 * (local `wrangler dev`, tests). Those unidentifiable callers share one
 * bucket rather than getting a free pass each, so the limit cannot be
 * sidestepped by stripping the header.
 */
export function clientIPFrom(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Check today's ceilings for `kind` and, if under both, record one use.
 *
 * Checks the global ceiling first, then the per-IP ceiling (when `clientIP`
 * and `ipDailyLimit` are given), and only bumps both counters once neither is
 * exhausted — a denied request costs nothing. Fail-open by construction: if
 * neither ceiling is reached the caller is always allowed, and there is no AI
 * call or moderation decision hiding inside this function to fail closed on.
 */
export async function checkAndBump(
  kv: KVNamespace,
  options: CheckAndBumpOptions,
): Promise<CheckAndBumpResult> {
  const { kind, clientIP, dailyLimit, ipDailyLimit } = options;

  const globalCount = await readCount(kv, todayKey(kind));
  if (globalCount >= dailyLimit) {
    return { allowed: false, retryAfter: secondsUntilMidnightUTC() };
  }

  let ipKey: string | undefined;
  if (clientIP !== undefined && ipDailyLimit !== undefined) {
    ipKey = await todayIPKey(kind, clientIP);
    const ipCount = await readCount(kv, ipKey);
    if (ipCount >= ipDailyLimit) {
      return { allowed: false, retryAfter: secondsUntilMidnightUTC() };
    }
  }

  await bumpCount(kv, todayKey(kind));
  if (ipKey !== undefined) {
    await bumpCount(kv, ipKey);
  }

  return { allowed: true };
}
