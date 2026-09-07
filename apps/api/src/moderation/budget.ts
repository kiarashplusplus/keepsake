/**
 * KV-based daily budget counters.
 *
 * Ported from Bayan `worker/src/budget.ts`. That Worker rations Workers AI
 * calls behind one unauthenticated endpoint; this one rations eight
 * different things — three AI calls (`mod_text`, `mod_image`, `suggest`) and
 * five write endpoints that don't touch AI at all (`listing`, `request`,
 * `upload`, `report`, `email`) — because Keepsake has no accounts either, so
 * the only caller identity available is an IP address.
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

import { dailyIpDigest, dailyEmailDigest } from "../lib/digest.js";
import { todayISO } from "../lib/day.js";

const TTL_SECONDS = 172_800; // 48 hours

/**
 * The nine things this Worker rations per calendar day.
 *
 * `report` and `email` joined the list in issue #92. Both were previously
 * guarded only by a `[[ratelimits]]` burst binding, which
 * `middleware/rateLimit.ts`'s own header calls best-effort and which was
 * measured leaking ~2.6x its configured limit (#8) — so neither had a hard
 * cap behind it at all:
 *
 * - `report` (`POST /api/listings/:id/reports`) drives the three-report
 *   auto-hide. The handler's per-listing, per-day `ip_digest` uniqueness
 *   check only stops one address reporting the *same* listing twice in a
 *   day; it never stopped that address walking the catalogue and reporting
 *   many *different* listings, each toward its own auto-hide.
 * - `email` (`POST /api/recover`, `POST /api/me/email`) is one shared
 *   counter for both routes on purpose: what's being rationed is outbound
 *   mail to a real inbox, not a URL path, and two kinds would let a caller
 *   have the allowance twice by alternating between them.
 *
 * `embed` (issue #38) joined in turn, and is global-only — no `ipDailyLimit`
 * is ever passed for it, see `search/reembed.ts` — because unlike `suggest`
 * it isn't behind its own client-callable endpoint; it only ever runs from
 * inside a listing create/edit this Worker has already authenticated and
 * rate-limited.
 */
export type BudgetKind =
  | "mod_text"
  | "mod_image"
  | "suggest"
  | "listing"
  | "request"
  | "upload"
  | "report"
  | "email"
  | "embed"
  | "request_confirm";

export interface CheckAndBumpOptions {
  kind: BudgetKind;
  /** Caller address from `CF-Connecting-IP`; omitted callers share one bucket. */
  clientIP?: string;
  /** Global ceiling for `kind` today. */
  dailyLimit: number;
  /** Per-IP ceiling for `kind` today. Omitted disables the per-IP check. */
  ipDailyLimit?: number;
  /** How many units of `dailyLimit` this single check consumes. Defaults to
   * 1. `moderation/pipeline.ts` passes the photo count here for `mod_image`
   * so the ceiling counts vision inferences, not listings (launch audit
   * finding 8 / issue #18: the budget used to be charged once per listing
   * while the pipeline makes up to five vision calls per listing, so the
   * configured number never meant what it said). */
  cost?: number;
  /**
   * Slice of `dailyLimit` held back from the general pool (issue #18): once
   * `globalCount` passes `dailyLimit - reservedFloor`, only a caller whose
   * own `kind` usage today is below `freshCallerCeiling` can still draw on
   * the remainder. Omitted (or 0) disables the floor and this behaves
   * exactly like the plain global/per-IP check below.
   *
   * This exists because the global ceiling has no notion of *whose* traffic
   * is spending it: ~50 distinct addresses each posting a handful of
   * listings — each individually well under `LISTING_IP_DAILY_BUDGET` — can
   * jointly exhaust the whole day's text-moderation budget, after which
   * every other giver's genuine listing silently parks until midnight UTC.
   * The floor doesn't stop that burst (nothing keyed only by IP can, per
   * `clientIPFrom`'s own doc comment — an attacker can always find more
   * addresses), but it guarantees a caller who hasn't already been part of
   * today's burst still gets through until the floor itself runs out, so
   * "everyone is starved" requires exhausting *both* pools, not one.
   */
  reservedFloor?: number;
  /** An IP counts as "fresh" (eligible for the reserved floor) while its own
   * count for `kind` today is below this. Ignored when `reservedFloor` is
   * unset or `clientIP` is omitted (e.g. the cron retry path, which never
   * knows the original caller's address). */
  freshCallerCeiling?: number;
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

/** Re-exported for `moderation/pipeline.ts`'s once-a-day capture alert on
 * budget exhaustion (issue #18), which needs the same UTC-day key this
 * module uses so the "have we already alerted today" flag rolls over at the
 * same boundary the counters do. Defined in `lib/day.ts` since issue #87 —
 * this module used to keep its own private copy, and two definitions of "the
 * day" is one more than a promise about daily rotation can survive. */
export { todayISO };

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
 *
 * The hashing itself moved to `lib/digest.ts`'s `dailyIpDigest` (issue #87)
 * so every site that turns an address into an identifier shares one
 * construction. Truncating its first 32 hex characters is byte-for-byte the
 * old 16-byte slice of the same digest of the same input, so existing KV
 * counters keep counting rather than resetting on deploy.
 */
async function clientDigest(clientIP: string): Promise<string> {
  return (await dailyIpDigest(clientIP)).slice(0, 32);
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

async function bumpCountBy(kv: KVNamespace, key: string, amount: number): Promise<number> {
  const next = (await readCount(kv, key)) + amount;
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
  const cost = options.cost ?? 1;
  const reservedFloor = options.reservedFloor ?? 0;
  const freshCallerCeiling = options.freshCallerCeiling ?? 0;

  const globalKey = todayKey(kind);
  const globalCount = await readCount(kv, globalKey);

  // With `reservedFloor` unset (every call site except the two moderation
  // budgets), `generalCeiling === dailyLimit` and `withinReservedPool` can
  // never be true (no `clientIP` path reaches it without `reservedFloor`),
  // so this is exactly the old global-then-per-IP check.
  const generalCeiling = Math.max(0, dailyLimit - reservedFloor);
  const withinGeneralPool = globalCount + cost <= generalCeiling;
  const withinReservedPool =
    !withinGeneralPool && reservedFloor > 0 && clientIP !== undefined && globalCount + cost <= dailyLimit;

  if (!withinGeneralPool && !withinReservedPool) {
    return { allowed: false, retryAfter: secondsUntilMidnightUTC() };
  }

  let ipKey: string | undefined;
  let ipCount = 0;
  if (clientIP !== undefined && (ipDailyLimit !== undefined || withinReservedPool)) {
    ipKey = await todayIPKey(kind, clientIP);
    ipCount = await readCount(kv, ipKey);
  }

  if (ipDailyLimit !== undefined && ipKey !== undefined && ipCount >= ipDailyLimit) {
    return { allowed: false, retryAfter: secondsUntilMidnightUTC() };
  }

  // The reserved floor only exists for a caller who hasn't already driven
  // the counter this far today — an address with `freshCallerCeiling` or
  // more uses of `kind` already recorded is treated as part of the same
  // burst that exhausted the general pool, not a new, unlucky giver.
  if (withinReservedPool && ipKey !== undefined && ipCount >= freshCallerCeiling) {
    return { allowed: false, retryAfter: secondsUntilMidnightUTC() };
  }

  await bumpCountBy(kv, globalKey, cost);
  if (ipKey !== undefined) {
    await bumpCountBy(kv, ipKey, cost);
  }

  return { allowed: true };
}

/**
 * The KV key holding today's count of messages aimed at one *recipient
 * address* for one kind. Same layout and same 48-hour TTL as the per-IP keys
 * above, under its own `addr:` segment so the two can never collide.
 *
 * Exported for the same reason `todayIPKey` is: a test that rebuilds the key
 * layout by hand is a test that can agree with itself while disagreeing with
 * the Worker.
 */
export async function todayRecipientKey(kind: BudgetKind, address: string): Promise<string> {
  const digest = (await dailyEmailDigest(address)).slice(0, 32);
  return `budget:addr:${kind}:${digest}:${todayISO()}`;
}

/**
 * Issue #188: how many messages this Worker will aim at one address today,
 * counted per address rather than per sender.
 *
 * Every other ceiling here answers "how much may this caller do?" and is keyed
 * by the caller's IP. That question cannot bound a mail flood aimed at someone
 * else: the attacker is not the person being harmed, and `clientIPFrom`'s own
 * doc comment concedes that an attacker can always find more addresses. This
 * one answers the question that matters to the victim instead — "how much mail
 * can arrive here today, from anyone?" — which is the only shape of limit that
 * an attacker cannot widen by moving.
 *
 * Deliberately *not* folded into `checkAndBump`: that function's contract is
 * "check the global pool, then the caller's slice of it", and a recipient is
 * neither. Fitting it in would have meant a third optional key with different
 * semantics from the two already there, which is how a limiter ends up
 * counting something other than what its call sites think.
 *
 * Read-then-write, non-atomic, for the same reason and with the same
 * consequence as the counters above: concurrent sends can undercount by a
 * handful. That is acceptable here — a burst of five where the ceiling says
 * three is not the attack this stops, which is hundreds.
 */
export async function checkAndBumpRecipient(
  kv: KVNamespace,
  options: { kind: BudgetKind; address: string; dailyLimit: number },
): Promise<CheckAndBumpResult> {
  const key = await todayRecipientKey(options.kind, options.address);
  const count = await readCount(kv, key);
  if (count + 1 > options.dailyLimit) {
    return { allowed: false, retryAfter: secondsUntilMidnightUTC() };
  }
  await bumpCountBy(kv, key, 1);
  return { allowed: true };
}
