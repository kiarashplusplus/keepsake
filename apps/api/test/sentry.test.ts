import { describe, expect, it } from "vitest";
import { buildSentryOptions } from "../src/index.js";
import { setTestEnvVar } from "./helpers.js";
import { env } from "cloudflare:test";

describe("buildSentryOptions", () => {
  it("returns undefined when SENTRY_DSN is unset — Sentry stays a no-op, no network", () => {
    setTestEnvVar("SENTRY_DSN", "");
    expect(buildSentryOptions(env)).toBeUndefined();
  });

  it("returns real options, wired to the redaction layer, once SENTRY_DSN is set", () => {
    setTestEnvVar("SENTRY_DSN", "https://example.ingest.sentry.io/1");
    const options = buildSentryOptions(env);
    expect(options?.dsn).toBe("https://example.ingest.sentry.io/1");
    expect(options?.tracesSampleRate).toBe(0);
    expect(typeof options?.beforeSend).toBe("function");
    expect(typeof options?.beforeBreadcrumb).toBe("function");
    setTestEnvVar("SENTRY_DSN", "");
  });

  it("redacts an Authorization: Bearer ks_... header on a synthetic event before it would ever be sent", () => {
    setTestEnvVar("SENTRY_DSN", "https://example.ingest.sentry.io/1");
    const options = buildSentryOptions(env);
    expect(options).toBeDefined();

    const syntheticEvent = {
      message: "unhandled error",
      request: {
        url: "https://keepsake.ing/api/me",
        headers: {
          authorization: "Bearer ks_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "cf-turnstile-response": "some-verify-token",
          "x-idempotency-key": "client-generated-key",
        },
      },
    };

    // `beforeSend`'s real signature takes `(event, hint)`, but the redaction
    // layer it's wired to (`@keepsake/observability/redact`) only ever reads
    // its first argument — see `buildSentryOptions`'s own comment on the
    // type-level mismatch this double-casts through.
    const redacted = (options?.beforeSend as unknown as (event: unknown) => typeof syntheticEvent)(syntheticEvent);

    expect(redacted.request.headers.authorization).toBe("[REDACTED]");
    expect(redacted.request.headers["cf-turnstile-response"]).toBe("[REDACTED]");
    expect(redacted.request.headers["x-idempotency-key"]).toBe("[REDACTED]");
    expect(redacted.request.url).toBe("https://keepsake.ing/api/me");

    setTestEnvVar("SENTRY_DSN", "");
  });
});
