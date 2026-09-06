import { describe, expect, it } from "vitest";
import { sentryOptions } from "../src/init";

describe("sentryOptions", () => {
  it("builds a plain options object with the right shape", () => {
    const options = sentryOptions({
      service: "keepsake-api",
      runtime: "cloudflare",
      dsn: "https://example.ingest.sentry.io/1",
      environment: "production",
      release: "abc123",
    });

    expect(options.dsn).toBe("https://example.ingest.sentry.io/1");
    expect(options.environment).toBe("production");
    expect(options.release).toBe("abc123");
    expect(options.tracesSampleRate).toBe(0);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.initialScope.tags).toEqual({ service: "keepsake-api", runtime: "cloudflare" });
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");
  });

  it("defaults environment to development when omitted", () => {
    const options = sentryOptions({ service: "keepsake-web", runtime: "browser" });
    expect(options.environment).toBe("development");
    expect(options.dsn).toBeUndefined();
  });

  it("wires beforeSend to the redaction layer", () => {
    const options = sentryOptions({ service: "keepsake-web", runtime: "browser" });
    const event = { request: { headers: { authorization: "Bearer secret" } } };
    const redacted = options.beforeSend(event) as { request: { headers: { authorization: string } } };
    expect(redacted.request.headers.authorization).toBe("[REDACTED]");
  });
});
