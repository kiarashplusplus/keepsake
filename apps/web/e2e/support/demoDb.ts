/**
 * A direct write into the local D1 file the UX baseline's `wrangler dev` is
 * already serving from — the same tool `global-setup.mjs` uses to seed
 * `postal_codes`, just run mid-test instead of at setup.
 *
 * `demoCatalog.ts` uses this for two things this harness cannot do through
 * the real API, and does here instead of adding a route that could do them
 * in production too:
 *
 *  - **#225 — pin a listing's id.** The API always mints a fresh ULID
 *    (`apps/api/src/lib/ids.ts`), so a re-seeded catalogue got a new id every
 *    run, and `tiltDegForId()`/`verticalOffsetForId()` (`src/lib/masonry.ts`)
 *    hashed that id into a new tilt and vertical offset on every capture even
 *    though every word on the card stayed the same. `pinListingIds()` runs
 *    right after the real create-and-moderate call and rewrites each minted
 *    id to a fixed one.
 *  - **#240 — confirm a request.** Issue #188 holds every request
 *    unconfirmed until the submitter clicks a link that exists only in an
 *    email, and deliberately so — `request.spec.ts` is explicit that this
 *    harness must not be given a way to reach that token.
 *    `confirmDemoRequests()` writes the same two effects
 *    `POST /api/requests/confirm` would have (`apps/api/src/routes/
 *    requestConfirm.ts`) directly into D1, rather than adding any
 *    confirm-token shortcut the real app could reach too.
 *
 * ## Why a concurrent write against `wrangler dev`'s own file is safe
 *
 * `--persist-to` is a real SQLite file on disk (miniflare's D1 gateway, not
 * an in-memory database), and `wrangler d1 execute --local` opens its own
 * short-lived connection to that file and closes it when the command exits —
 * it does not need `wrangler dev` to give up its handle. Verified by hand
 * before relying on it here: a scratch `wrangler dev` on a private port, a
 * listing created through it, an `UPDATE` run from a concurrent `wrangler d1
 * execute` against the same `--persist-to` directory, and a follow-up `GET`
 * from the still-running server all agreed on the same row with no lock
 * error either side.
 *
 * ## Why `PRAGMA foreign_keys = OFF` does not work here
 *
 * Every table with a `listing_id` (`photos`, `requests`, `reports`,
 * `moderation_events`, `listing_aspects`, `upload_batch_items`) carries
 * `REFERENCES listings(id)`, so rewriting `listings.id` alone would leave
 * every one of them pointing at an id nothing has any more — a `FOREIGN KEY
 * constraint failed`, the way SQLite catches exactly this mistake.
 * `PRAGMA foreign_keys = OFF` is the obvious fix and does not work: `wrangler
 * d1 execute --file`/`--command` sends every statement as one D1 `.batch()`,
 * which is one SQLite transaction, and SQLite silently refuses to change
 * `foreign_keys` while a transaction is open rather than erroring — measured
 * directly, the `UPDATE` still failed with the pragma set. `PRAGMA
 * defer_foreign_keys = 1` is what SQLite documents for exactly this case
 * (reassigning a primary key and its dependents together): unlike
 * `foreign_keys` it *is* legal mid-transaction, it defers every FK check to
 * COMMIT rather than turning them off, and it resets itself automatically
 * once the transaction ends — so nothing here ever has to turn it back on.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Mirrors `playwright.config.ts`'s `STATE_DIR`, computed from this file's
 * own location instead: `apps/web/e2e/support/demoDb.ts` -> `apps/api`. */
const API_DIR = path.resolve(__dirname, "../../../api");
const STATE_DIR = path.join(API_DIR, ".wrangler", "e2e-state");

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Runs every statement in one `wrangler d1 execute` call — one D1 batch, one
 * transaction, one `defer_foreign_keys` scope — against the directory
 * `playwright.config.ts`'s `webServer` started `wrangler dev` on.
 */
function runDemoSql(statements: readonly string[]): void {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "keepsake-db",
      "--local",
      "--persist-to",
      STATE_DIR,
      "--command",
      statements.join("\n"),
    ],
    { cwd: API_DIR, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
}

/** Every table carrying a `listing_id` foreign key — see
 * `apps/api/migrations/*.sql`. Rewritten alongside `listings.id` itself so
 * no row is left pointing at an id nothing has any more. */
const LISTING_ID_CHILD_TABLES = [
  "photos",
  "requests",
  "reports",
  "moderation_events",
  "listing_aspects",
  "upload_batch_items",
] as const;

/**
 * Rewrites each minted listing id to its pinned counterpart, in one
 * transaction. `mintedToPinned` maps the id the API actually returned to the
 * fixed id the catalogue wants it to have from now on.
 */
export function pinListingIds(mintedToPinned: Readonly<Record<string, string>>): void {
  const statements: string[] = ["PRAGMA defer_foreign_keys = 1;"];
  for (const [minted, pinned] of Object.entries(mintedToPinned)) {
    statements.push(`UPDATE listings SET id = ${sqlString(pinned)} WHERE id = ${sqlString(minted)};`);
    for (const table of LISTING_ID_CHILD_TABLES) {
      statements.push(`UPDATE ${table} SET listing_id = ${sqlString(pinned)} WHERE listing_id = ${sqlString(minted)};`);
    }
  }
  runDemoSql(statements);
}

/**
 * Marks each request confirmed and bumps its listing's `request_count` by
 * one — the two effects on the giver's side that
 * `POST /api/requests/confirm` has (`confirmed_at`/`status`, and the count),
 * minus the two emails it also sends, which nothing in this capture reads.
 * `withdrawTokenIdToListingId` maps each request's id to the listing it
 * belongs to. `withdraw_token_hash` carries a `UNIQUE` index (0001_init.sql
 * via the 20260907190500 rebuild), so it only has to be present and
 * distinct — nothing in this capture withdraws a request, so a random value
 * nobody holds the raw token for satisfies the constraint without meaning
 * anything.
 */
export function confirmDemoRequests(requestIdToListingId: Readonly<Record<string, string>>): void {
  const now = Date.now();
  const statements: string[] = [];
  for (const [requestId, listingId] of Object.entries(requestIdToListingId)) {
    const withdrawTokenHash = randomUUID().replace(/-/g, "");
    statements.push(
      `UPDATE requests SET status = 'open', confirmed_at = ${now}, withdraw_token_hash = ${sqlString(withdrawTokenHash)} ` +
        `WHERE id = ${sqlString(requestId)} AND confirmed_at IS NULL;`,
    );
    statements.push(`UPDATE listings SET request_count = request_count + 1 WHERE id = ${sqlString(listingId)};`);
  }
  runDemoSql(statements);
}
