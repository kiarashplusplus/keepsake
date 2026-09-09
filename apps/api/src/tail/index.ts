/**
 * `keepsake-tail` — the Tail Worker (issue #159, step 1).
 *
 * Cloudflare invokes this once per batch of trace events produced by whatever
 * Workers name it in `tail_consumers`. Here that is the API Worker, per
 * environment: `keepsake` → `keepsake-tail`, `keepsake-preview` →
 * `keepsake-tail-preview`, `keepsake-production` →
 * `keepsake-tail-production`. Configured by `apps/api/wrangler.tail.toml`,
 * which restates its D1 binding and vars for every environment because
 * Wrangler inherits neither — the same rule the API Worker's own config
 * documents at length, and the reason `tail_consumers` has to be repeated in
 * all three of that file's blocks too.
 *
 * All of the work is in `./errorEvents.ts`. This file is the entrypoint and
 * the last line of defence:
 *
 * **It must never throw.** A tail consumer sits downstream of an
 * already-failing request, and Cloudflare records a throwing tail invocation
 * as a failure of *this* Worker with the events dropped — so a bug here would
 * turn "an error happened" into "an error happened and the record of it is
 * gone", which is worse than not having built this. Every path is wrapped,
 * and the fallback is a plain `console.error` with a redacted message.
 *
 * Nothing tails this Worker, deliberately: a Worker that consumed its own
 * trace events would report on its own reporting, forever. Its console output
 * goes to Workers Logs (`[observability]` in `wrangler.tail.toml`) and is
 * read the same way any other Worker's is — with the same 3-day retention
 * this whole feature exists to escape, which is an acceptable trade for the
 * one Worker whose failure mode is "the durable copy stops being written"
 * rather than "a giver's request failed".
 */
import { redactString } from "@keepsake/observability/redact";
import { persistTailEvents, type TailEnv } from "./errorEvents.js";

export default {
  async tail(events: TraceItem[], env: TailEnv): Promise<void> {
    try {
      const result = await persistTailEvents(env, events);
      if (result.dropped > 0) {
        // Warn, not error: the ceiling refusing writes is the ceiling
        // working. The durable record of it is the `cap_notice` row in
        // `error_events` itself, which is what an admin actually reads;
        // this line is for whoever is watching this Worker directly.
        console.warn("tail: per-minute ceiling refused error events", {
          environment: env.ENVIRONMENT,
          considered: result.considered,
          persisted: result.persisted,
          dropped: result.dropped,
        });
      }
    } catch (err) {
      // Redacted because the message can carry a D1 error containing the
      // statement's bound values, and those are error lines from the
      // producing Worker.
      console.error("tail: failed to persist error events", {
        environment: env.ENVIRONMENT,
        error: redactString(err instanceof Error ? err.message : String(err)),
      });
    }
  },
};
