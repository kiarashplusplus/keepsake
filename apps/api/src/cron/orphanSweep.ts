// M4: photos uploaded but never attached to a listing (abandoned `give`
// flows, abuse probes) are deleted from R2 + D1 once they're more than 24h
// old. Runs once a day, off-peak. See plan "API (Hono, apps/api)" cron table
// and Risks #8 (orphan-upload abuse).
export async function orphanSweep(env: Env): Promise<void> {
  console.log("orphanSweep: stub, no-op in M0", { environment: env.ENVIRONMENT });
}
