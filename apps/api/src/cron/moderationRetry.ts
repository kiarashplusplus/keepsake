// M1: pending listings whose moderation call errored or never landed (Worker
// eviction mid-`waitUntil`, AI timeout) get re-run here on a 5-minute cron.
// After 3 attempts a listing is escalated to `needs_review` rather than
// retried forever. See plan "Moderation pipeline" and the cron table under
// "API (Hono, apps/api)".
export async function moderationRetry(env: Env): Promise<void> {
  console.log("moderationRetry: stub, no-op in M0", { environment: env.ENVIRONMENT });
}
