/**
 * Builds a plain Sentry options object — no `@sentry/*` import here, so this
 * package stays dependency-free. Callers pass the result straight to
 * `Sentry.init()` (web) or `withSentry()` (Cloudflare Worker).
 *
 * `tracesSampleRate: 0`: no performance traces or Replay. Replay in
 * particular would capture photos and stories, which is the one thing this
 * app must never send to a third party without explicit review.
 */
import { redactBreadcrumb, redactEvent } from "./redact";

export type ObservabilityRuntime = "browser" | "cloudflare";

export type SentryOptionsInput = {
  service: string;
  runtime: ObservabilityRuntime;
  dsn?: string;
  environment?: string;
  release?: string;
};

export type SentryOptions = {
  dsn: string | undefined;
  environment: string;
  release: string | undefined;
  tracesSampleRate: number;
  sendDefaultPii: boolean;
  beforeSend: (event: unknown) => unknown;
  beforeBreadcrumb: (breadcrumb: unknown) => unknown;
  initialScope: {
    tags: {
      service: string;
      runtime: ObservabilityRuntime;
    };
  };
};

export function sentryOptions(input: SentryOptionsInput): SentryOptions {
  return {
    dsn: input.dsn,
    environment: input.environment ?? "development",
    release: input.release,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: redactEvent,
    beforeBreadcrumb: redactBreadcrumb,
    initialScope: {
      tags: {
        service: input.service,
        runtime: input.runtime,
      },
    },
  };
}
