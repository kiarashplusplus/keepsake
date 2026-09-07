/**
 * Capture layer for Cloudflare Workers Logs — replaces the `@sentry/*` SDK
 * removed in issue #14 (`SENTRY_DSN` was never set, so every Sentry call was
 * a silent no-op no agent could fix without Kiarash's account). There is no
 * client to build and no network call to make here: `console.error()` /
 * `console.warn()` write to stdout, and Workers Logs — enabled via
 * `apps/api/wrangler.toml`'s `[observability]` block, a config flag, not a
 * binding — ingests it automatically. Uncaught exceptions are captured by
 * the platform without this module even being called; this file exists for
 * the *handled* cases the old `Sentry.captureException`/`captureMessage`
 * call sites needed.
 *
 * Every call passes a single plain object to `console.error`/`console.warn`
 * rather than a `JSON.stringify`'d string. Workers Logs indexes an object's
 * own fields as separate, filterable columns (`level`, `tags.cron`,
 * `error.name`, ...); a stringified blob is one opaque `message` field with
 * nothing to query on. Don't collapse this back to a string.
 *
 * Redaction is the part of the old Sentry work most worth keeping, so it is
 * reused unchanged: every message, tag, extra, and error message/stack runs
 * through `./redact`'s `redactDeep`/`redactString` before it is ever logged.
 *
 * This module must never throw. An observability call sits on an
 * already-failing path (an error handler, a budget-exhaustion alert, a
 * cron's catch block) — if reporting the failure could itself throw, it
 * could take down the very request/job it was trying to report on. Every
 * exported function wraps its body in try/catch and falls back to a
 * minimal, deliberately trivial `console.error` that cannot itself fail.
 */
import { redactDeep, redactString } from "./redact";

export type CaptureLevel = "error" | "warning";

export interface CaptureOptions {
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
}

/**
 * `service`/`environment`/`release` used to come from Sentry's
 * `initialScope.tags` (see the now-deleted `sentryOptions`). There is no SDK
 * client to hold onto that state now, so `configureCapture` sets it once —
 * `apps/api/src/index.ts` calls it from the top-level request middleware
 * (every HTTP request) and from `runCron` (every scheduled invocation,
 * which never touches Hono middleware). All three values are identical for
 * every concurrent request a given Worker deployment serves, so more than
 * one in-flight call re-setting the same values is harmless — there is
 * nothing here that varies per-request.
 */
export interface CaptureContext {
  service: string;
  environment: string;
  release?: string;
}

let context: CaptureContext = { service: "unknown", environment: "development" };

export function configureCapture(next: CaptureContext): void {
  context = next;
}

interface CapturedError {
  name: string;
  message: string;
  stack: string | undefined;
}

/**
 * Stable shape, field names kept intentionally boring so a Workers Logs
 * filter written today still matches tomorrow:
 *
 * - `event`: always `"capture"` — the discriminator that separates these
 *   lines from the Worker's other `console.*` output in the same log feed.
 * - `level`: `"error"` | `"warning"`.
 * - `service` / `environment` / `release`: from `configureCapture`.
 * - `message`: the human-readable summary (an exception's `.message`, or
 *   the literal string passed to `captureMessage`).
 * - `error`: present only for `captureException` — `{ name, message, stack }`.
 * - `tags` / `extra`: whatever the call site passed, redacted.
 * - `ts`: ISO timestamp — Workers Logs stamps its own ingestion time too,
 *   but this is the moment the Worker itself observed the failure.
 */
interface CaptureLogLine {
  event: "capture";
  level: CaptureLevel;
  service: string;
  environment: string;
  release: string | undefined;
  message: string;
  error?: CapturedError;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  ts: string;
}

function toCapturedError(error: unknown): CapturedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactString(error.message),
      stack: error.stack ? redactString(error.stack) : undefined,
    };
  }
  return { name: "NonError", message: redactString(String(error)), stack: undefined };
}

function buildLine(level: CaptureLevel, message: string, opts: CaptureOptions | undefined, error?: unknown): CaptureLogLine {
  const line: CaptureLogLine = {
    event: "capture",
    level,
    service: context.service,
    environment: context.environment,
    release: context.release,
    message: redactString(message),
    ts: new Date().toISOString(),
  };
  if (error !== undefined) {
    line.error = toCapturedError(error);
  }
  if (opts?.tags) {
    line.tags = redactDeep(opts.tags) as Record<string, unknown>;
  }
  if (opts?.extra) {
    line.extra = redactDeep(opts.extra) as Record<string, unknown>;
  }
  return line;
}

/** Last-resort fallback if building or logging the real line somehow threw
 * — no redaction, no interpolation, nothing that could itself fail. If even
 * this throws, there is genuinely nothing left to do and the caller's own
 * try/catch (there is always one at the call sites this is used from) takes
 * over. */
function logFallback(): void {
  try {
    console.error({ event: "capture", level: "error", message: "capture failed" });
  } catch {
    // Nothing left to do.
  }
}

export function captureException(error: unknown, opts?: CaptureOptions): void {
  try {
    let message: string;
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      message = "unreadable error";
    }
    console.error(buildLine("error", message, opts, error));
  } catch {
    logFallback();
  }
}

export function captureMessage(message: string, level: CaptureLevel, opts?: CaptureOptions): void {
  try {
    const line = buildLine(level, message, opts);
    if (level === "warning") {
      console.warn(line);
    } else {
      console.error(line);
    }
  } catch {
    logFallback();
  }
}
