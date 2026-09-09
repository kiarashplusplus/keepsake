/**
 * Issue #159, step 1: turn the API Worker's error stream into rows in D1.
 *
 * This is the body of the Tail Worker (`./index.ts` is the four-line
 * entrypoint). It lives in `apps/api` rather than in a package or a second
 * app because everything it needs is already here — the `Env`, the D1
 * migrations, the redactor's only other consumer, and a test suite that runs
 * against real local D1 — and a second package would have meant a second
 * `wrangler types`, a second vitest pool and a second copy of the schema's
 * opinions. What it does need on its own is a second **wrangler config**
 * (`apps/api/wrangler.tail.toml`), because a tail consumer is a separate
 * Worker script with its own `main`; `apps/api/test/tailConfig.test.ts` is
 * what keeps the two configs agreeing about databases and script names.
 *
 * ## What is kept
 *
 * Error- and warning-level lines, plus every uncaught exception on the trace
 * item. The issue scopes this as "error-level lines and `captureException`
 * records"; warnings are in for a reason that is not scope creep — the
 * Observatory panel this table now feeds already renders a warning feed and a
 * warning count, and `/api/admin/health` deliberately routes its "needs a
 * human" signals (a stale cron, a listing auto-hidden and awaiting review)
 * through `console.warn` so one filter catches all of them. Persisting errors
 * only would have replaced that panel's warning half with a confident zero.
 *
 * Everything else — `console.log`, `info`, `debug`, and the request logs a
 * tail consumer receives for every single invocation — is dropped here and
 * never reaches D1.
 *
 * ## Redaction
 *
 * **Every string that lands in a row goes through
 * `@keepsake/observability/redact` first**, and there is exactly one place
 * that happens: `redactEvent` below. Not a second redactor, and not a second
 * list of sensitive key names — #284 was two such lists drifting apart, and
 * #170 was two definitions of "what an address looks like".
 *
 * A capture line has already been redacted once by `capture.ts` before it was
 * logged, so for those this is belt and braces. It is not redundant for the
 * rest: `docs/design/ops.md` states plainly that a bare `console.error` never
 * reaches `redactString`, and the Worker has plenty of those. A log line
 * expires in three days; a row here lives for thirty, which makes it a much
 * worse place to leave a requester's address.
 *
 * ## Volume
 *
 * A per-minute ceiling, enforced as a predicate on the insert itself — the
 * same shape `src/bulk/usage.ts` and `routes/bulk.ts` use for the estate
 * ceilings, and for the same reason: a counter read in one statement and
 * spent in another is a ceiling two concurrent writers can both walk through.
 * D1 runs `batch()` as one transaction, and each row's `WHERE` sees the rows
 * this same batch already inserted — **measured, not assumed**: with 58 rows
 * already in the minute and a five-line delivery, exactly two land
 * (`test/tailErrorEvents.test.ts`, "counts the rows written earlier in the
 * same batch"). If D1 evaluated the predicate against a pre-batch snapshot,
 * all five would, and the overshoot would only ever appear at that boundary.
 *
 * What the ceiling refuses is recorded rather than swallowed: one
 * `cap_notice` row per minute carries the running count of dropped lines, so
 * a runaway loop looks different from a quiet week *in the feed itself*
 * rather than only in a log line nobody reads.
 */
import { redactDeep, redactString } from "@keepsake/observability/redact";
import { ulid } from "../lib/ids.js";

/**
 * The bindings this Worker actually has. Deliberately a structural subset of
 * `src/env.ts`'s `Env` rather than `Env` itself: `wrangler.tail.toml` binds
 * D1 and nothing else, and typing this as the full `Env` would let a future
 * edit reach for `env.BUCKET` or `env.KV` here and still compile, then fail
 * at runtime on a Worker that has never had them.
 */
export interface TailEnv {
  DB: D1Database;
  ENVIRONMENT?: string;
}

const MINUTE_MS = 60 * 1000;

/**
 * How many lines may be persisted per minute, per environment.
 *
 * Sized against the failure it exists to bound rather than against expected
 * volume, which is near zero: a Worker stuck in a retry loop can emit
 * thousands of identical lines a minute, and this table must not become the
 * incident. 60/minute is one per second sustained — far above any real error
 * rate for this site, and a hard ceiling of 86,400 rows/day even if something
 * screams for 24 hours straight. At ~1 KB a row that is ~86 MB/day worst
 * case, against a 30-day retention, which is a bounded number somebody can
 * reason about rather than "however much a bad loop produces".
 *
 * A constant, not a `[vars]` entry, on purpose: a var would have to be
 * declared in *both* wrangler configs and in `.env.example`, and preflight's
 * `env-parity`/`var-usage` checks only read the API Worker's file — a
 * ceiling that could silently differ between the two configs is worse than
 * one written down once. Exported so tests and the notice text read the same
 * number this module enforces.
 */
export const MAX_ERROR_EVENTS_PER_MINUTE = 60;

/**
 * How long a persisted line is kept, swept nightly by
 * `src/cron/errorEventSweep.ts`.
 *
 * **Must be at least the widest window the Observatory can be asked for**
 * (`OBSERVATORY_WINDOWS`'s 30 days). Anything shorter and the panel labels a
 * 30-day window over 14 days of rows, which is the same lie
 * `fetchEdgeTelemetry`'s window ceiling exists to avoid — asserted by
 * `test/tailErrorEvents.test.ts` against the contract's own list rather than
 * left as a comment.
 */
export const ERROR_EVENT_RETENTION_DAYS = 30;
export const ERROR_EVENT_RETENTION_MS = ERROR_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Bounds on what one row may hold. A stack trace is the field that can run
 * to tens of kilobytes; the rest are here so a pathological line cannot make
 * one row cost what a hundred should. Truncation is marked, never silent. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 8000;
const MAX_DETAIL_CHARS = 4000;

const CAP_NOTICE_KIND = "cap_notice";
const CAP_NOTICE_PREFIX = "error-event volume cap: ";
const CAP_NOTICE_SUFFIX = ` line(s) dropped in this minute (ceiling ${MAX_ERROR_EVENTS_PER_MINUTE}/min, apps/api/src/tail/errorEvents.ts)`;

export function capNoticeMessage(dropped: number): string {
  return `${CAP_NOTICE_PREFIX}${dropped}${CAP_NOTICE_SUFFIX}`;
}

export type ErrorEventLevel = "error" | "warning";
export type ErrorEventKind = "exception" | "capture" | "console";

/** One candidate line, as read off the trace item and **before** redaction.
 * Nothing in this shape may be written to D1: `redactEvent` is the only
 * function that turns one of these into something the insert accepts. */
interface RawErrorEvent {
  observedAt: number;
  scriptName: string | null;
  environment: string | null;
  release: string | null;
  level: ErrorEventLevel;
  kind: ErrorEventKind;
  message: string;
  errorName: string | null;
  stack: string | null;
  requestId: string | null;
  outcome: string | null;
  detail: unknown;
}

/** A row, redacted and bounded, ready to insert. */
export interface StoredErrorEvent {
  observedAt: number;
  scriptName: string | null;
  environment: string | null;
  release: string | null;
  level: ErrorEventLevel;
  kind: ErrorEventKind;
  message: string;
  errorName: string | null;
  stack: string | null;
  requestId: string | null;
  outcome: string | null;
  detail: string | null;
}

export interface TailPersistResult {
  /** Lines the filter kept out of everything in the delivery. */
  considered: number;
  persisted: number;
  /** Refused by the per-minute ceiling — never "failed to write". */
  dropped: number;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/** `warn` is what the runtime calls it; `warning` is what `capture.ts`,
 * Cloudflare's own `$metadata.level` and the Observatory's panel all call it.
 * One spelling reaches D1. */
function normaliseLevel(level: string | undefined): ErrorEventLevel | null {
  const value = (level ?? "").toLowerCase();
  if (value === "error" || value === "fatal") return "error";
  if (value === "warn" || value === "warning") return "warning";
  return null;
}

/**
 * The structured object `@keepsake/observability/capture` writes — recognised
 * by its `event: "capture"` discriminator, which is exactly what that field
 * was added for. Read defensively: this arrives from another Worker's log
 * stream, so it is untrusted input with a hoped-for shape, not a value this
 * code produced.
 */
interface CaptureShape {
  event?: unknown;
  level?: unknown;
  message?: unknown;
  service?: unknown;
  environment?: unknown;
  release?: unknown;
  error?: { name?: unknown; message?: unknown; stack?: unknown };
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

function asCaptureLine(value: unknown): CaptureShape | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as CaptureShape;
  return candidate.event === "capture" ? candidate : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `TraceLog.message` is typed `any` because it is the console call's
 * arguments — usually an array, occasionally a bare value. Both are handled;
 * neither is trusted to be either. */
function logArguments(message: unknown): unknown[] {
  if (Array.isArray(message)) return message;
  return message === undefined ? [] : [message];
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserialisable]";
  }
}

function rawFromCapture(line: CaptureShape, item: TraceItem, timestamp: number): RawErrorEvent | null {
  const level = normaliseLevel(asString(line.level) ?? "error");
  if (level === null) return null;
  const tags = (line.tags ?? {}) as Record<string, unknown>;
  return {
    observedAt: timestamp,
    scriptName: item.scriptName,
    environment: asString(line.environment),
    release: asString(line.release),
    level,
    kind: "capture",
    message: asString(line.message) ?? "(no message)",
    errorName: asString(line.error?.name),
    stack: asString(line.error?.stack),
    requestId: asString(tags.requestId),
    outcome: item.outcome ?? null,
    detail: line.tags || line.extra ? { tags: line.tags, extra: line.extra } : null,
  };
}

/**
 * Every line in one delivery worth keeping, in the order the runtime reported
 * them. Pure: no D1, no clock, no redaction — so a test can assert the filter
 * on its own, and so the redaction step below is the single choke point it
 * claims to be.
 *
 * `receivedAt` is the caller's clock, used only where the runtime gave us no
 * timestamp of its own — a trace item with no `eventTimestamp`, or a log line
 * with no `timestamp` on an item that also lacked one. It is a required
 * parameter rather than an internal `Date.now()` so that "no clock" above is
 * true as written: the same input always produces the same output, which is
 * what lets the ordering and window assertions in
 * `test/tailErrorEvents.test.ts` pin exact timestamps instead of ranges.
 */
export function extractErrorEvents(items: TraceItem[], receivedAt: number): RawErrorEvent[] {
  const out: RawErrorEvent[] = [];

  for (const item of items) {
    const fallbackTs = item.eventTimestamp ?? receivedAt;

    // Uncaught exceptions first: the platform records these itself, and they
    // are the ones no `captureException` call site ever saw.
    for (const exception of item.exceptions ?? []) {
      out.push({
        observedAt: exception.timestamp ?? fallbackTs,
        scriptName: item.scriptName,
        environment: null,
        release: null,
        level: "error",
        kind: "exception",
        message: exception.message ?? "(no message)",
        errorName: exception.name ?? null,
        stack: exception.stack ?? null,
        requestId: null,
        outcome: item.outcome ?? null,
        detail: null,
      });
    }

    for (const log of item.logs ?? []) {
      const args = logArguments(log.message);
      const capture = asCaptureLine(args[0]);
      if (capture) {
        const raw = rawFromCapture(capture, item, log.timestamp ?? fallbackTs);
        if (raw) out.push(raw);
        continue;
      }

      const level = normaliseLevel(log.level);
      if (level === null) continue;

      const [first, ...rest] = args;
      out.push({
        observedAt: log.timestamp ?? fallbackTs,
        scriptName: item.scriptName,
        environment: null,
        release: null,
        level,
        kind: "console",
        message: describe(first),
        errorName: null,
        stack: null,
        requestId: null,
        outcome: item.outcome ?? null,
        detail: rest.length > 0 ? rest : null,
      });
    }
  }

  return out;
}

/**
 * **The redaction choke point.** The only function that produces a value the
 * insert below accepts, so a line cannot reach D1 without passing through
 * `redactString`/`redactDeep` here.
 *
 * `redactDeep` for the structured half (it redacts by key name *and* by value
 * shape, and recurses), `redactString` for the flat fields. Truncation runs
 * after redaction, never before: cutting a string first could leave a partial
 * address or token that no pattern matches any more.
 */
export function redactEvent(raw: RawErrorEvent): StoredErrorEvent {
  const detail = raw.detail === null || raw.detail === undefined ? null : describe(redactDeep(raw.detail));
  return {
    observedAt: raw.observedAt,
    scriptName: raw.scriptName === null ? null : redactString(raw.scriptName),
    environment: raw.environment === null ? null : redactString(raw.environment),
    release: raw.release === null ? null : redactString(raw.release),
    level: raw.level,
    kind: raw.kind,
    message: truncate(redactString(raw.message), MAX_MESSAGE_CHARS),
    errorName: raw.errorName === null ? null : truncate(redactString(raw.errorName), MAX_MESSAGE_CHARS),
    stack: raw.stack === null ? null : truncate(redactString(raw.stack), MAX_STACK_CHARS),
    requestId: raw.requestId === null ? null : redactString(raw.requestId),
    outcome: raw.outcome === null ? null : redactString(raw.outcome),
    detail: detail === null ? null : truncate(detail, MAX_DETAIL_CHARS),
  };
}

/**
 * One row's insert, with the per-minute ceiling as its own `WHERE` clause.
 *
 * The subquery counts what this minute has already written — excluding
 * `cap_notice` rows, which are bounded to one per minute by their
 * deterministic id and must not eat a slot from the lines they are reporting
 * on. `meta.changes === 0` on this statement therefore means "refused by the
 * ceiling", and nothing else: there is no other predicate here to fail.
 */
function insertStatement(db: D1Database, event: StoredErrorEvent, now: number, minuteStart: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO error_events
         (id, observed_at, received_at, script_name, environment, release,
          level, kind, message, error_name, stack, request_id, outcome, detail)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM error_events
                WHERE received_at >= ? AND kind <> '${CAP_NOTICE_KIND}') < ?`,
    )
    .bind(
      ulid(now),
      event.observedAt,
      now,
      event.scriptName,
      event.environment,
      event.release,
      event.level,
      event.kind,
      event.message,
      event.errorName,
      event.stack,
      event.requestId,
      event.outcome,
      event.detail,
      minuteStart,
      MAX_ERROR_EVENTS_PER_MINUTE,
    );
}

/**
 * The one row per minute that says the ceiling refused something, upserted so
 * repeated deliveries within the same minute accumulate into one honest total
 * rather than one notice per delivery.
 *
 * Deliberately not itself subject to the ceiling: it is bounded to a single
 * row per minute by its own primary key, and a cap notice that could be
 * capped is a cap notice nobody sees on exactly the minute it matters.
 *
 * `observed_at` is the delivery clock, and is moved forward on every upsert —
 * *not* `minuteStart`, which is what identifies the row. The two are only a
 * minute apart, but the panel's feed is `ORDER BY observed_at DESC LIMIT 50`
 * and a capped minute is by definition one with at least sixty rows newer
 * than its own start: stamping the notice at `minuteStart` sorts it below
 * every line it is reporting on and pushes it off the end of the very feed it
 * exists to appear in. Being excluded from the ceiling is not enough on its
 * own; it also has to be readable. `test/tailErrorEvents.test.ts` ("the cap
 * notice survives the feed's own row cap") is what holds this.
 */
async function recordCapNotice(db: D1Database, dropped: number, now: number, minuteStart: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO error_events
         (id, observed_at, received_at, level, kind, message, dropped)
       VALUES (?, ?, ?, 'warning', '${CAP_NOTICE_KIND}', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         observed_at = excluded.observed_at,
         received_at = excluded.received_at,
         dropped = error_events.dropped + excluded.dropped,
         message = ? || (error_events.dropped + excluded.dropped) || ?`,
    )
    .bind(
      `cap-${minuteStart}`,
      now,
      now,
      capNoticeMessage(dropped),
      dropped,
      CAP_NOTICE_PREFIX,
      CAP_NOTICE_SUFFIX,
    )
    .run();
}

/**
 * Stamps the single `tail_deliveries` row, which is the evidence that a tail
 * consumer is actually attached to this database.
 *
 * Written on **every** delivery, including the overwhelming majority that
 * carry nothing worth persisting — that is the point: it separates "no errors
 * happened" from "nothing has ever delivered here", and only the first of
 * those is safe to render as an empty panel.
 *
 * Throttled to one write a minute by the `WHERE` on the update branch, so a
 * busy Worker costs one D1 write per minute rather than one per request.
 */
async function recordDelivery(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tail_deliveries (id, first_delivery_at, last_delivery_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_delivery_at = excluded.last_delivery_at
         WHERE tail_deliveries.last_delivery_at < ?`,
    )
    .bind(now, now, now - MINUTE_MS)
    .run();
}

/**
 * Filter, redact, cap, write. The whole job of the Tail Worker.
 *
 * `recordDelivery` runs first and unconditionally: a delivery that arrives
 * and persists nothing is still proof the pipeline works, and recording it
 * before the writes means an exception in the write path cannot erase that
 * proof.
 */
export async function persistTailEvents(
  env: TailEnv,
  items: TraceItem[],
  now: number = Date.now(),
): Promise<TailPersistResult> {
  await recordDelivery(env.DB, now);

  const candidates = extractErrorEvents(items, now);
  if (candidates.length === 0) return { considered: 0, persisted: 0, dropped: 0 };

  const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;

  // One delivery can carry more lines than a whole minute is allowed. The
  // D1 predicate would refuse the excess anyway; slicing here keeps the
  // batch a bounded size instead of asking D1 to reject ten thousand
  // statements one at a time.
  const admitted = candidates.slice(0, MAX_ERROR_EVENTS_PER_MINUTE);

  const results = await env.DB.batch(
    admitted.map((raw) => insertStatement(env.DB, redactEvent(raw), now, minuteStart)),
  );
  const persisted = results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
  // Everything the filter kept and this run did not write — the excess sliced
  // off above included, since it was refused by the same ceiling, just
  // earlier and more cheaply.
  const dropped = candidates.length - persisted;

  if (dropped > 0) {
    await recordCapNotice(env.DB, dropped, now, minuteStart);
  }

  return { considered: candidates.length, persisted, dropped };
}
