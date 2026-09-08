# Estate bulk upload

Status: `[TODO]` — API, schema and the web workspace's screens are written, but **nothing here has
been driven from a real browser by a real person**. The admission code is gone (2026-09-08, status
entry at the bottom), so `/bulk` is now self-serve wherever `BULK_UPLOAD` is `"1"` — preview only. Read "What is not built" before believing any
part of this is usable. The status line at the bottom is the one that is kept current.

Someone clearing a house has fifty objects and one evening at a time. The give flow is five steps
per keepsake, and five steps fifty times is not a flow, it is a job. This is the machinery for
preparing many items across several sittings and publishing the ready ones together.

**It is still free gifting.** No prices, no reservations, no bidding, nothing that would make an
"estate sale" a sale. `terms.html`'s "Gifting only, never sales" is unchanged and this feature does
not lean on it being reinterpreted later. The intake machinery would support a paid model without
rework, and that is a property of the design, not a plan.

## The rule everything else follows from

**A draft is permissive; a submission is not.**

A draft item may hold a title with no story, a story of four characters, no category at all.
Someone standing in their late mother's bedroom types what they know when they know it, and a form
that refuses to save an incomplete thought loses the thought.

So no publishing rule is restated anywhere in this feature. `packages/contracts/src/bulk.ts`'s
`DraftItemFields` is *derived* — `CreateListingInput.pick({title, story, category, aspects}).partial()`
— and the full rules are applied exactly once, at submission, by running that same
`CreateListingInput` over each assembled item. An item's `ready` flag is computed by the API from
that parse, not by the client, so the review summary ("42 ready · 6 need details") and the
submission cannot disagree about what ready means.

A second copy of "a story is at least 20 characters" is a copy that drifts, and the drift stays
invisible until a bulk-created listing carries something `POST /api/listings` would have refused.

## Drafts live outside `listings`

A draft is not a listing that happens to be invisible. It has no place, no version and no
moderation history, and it must not be reachable by the feed, FTS, the sitemap, the moderation
retry cron, or any keyset cursor.

Adding a sixth `status` to `listings` would have been less code and would have put every one of
those surfaces one forgotten `WHERE` clause away from publishing a half-written draft. A listing is
created at submission and not one moment earlier.

## Photos, and the sweep that would have eaten them

`cron/orphanSweep.ts` deletes any photo with `listing_id IS NULL` older than 24 hours, plus its two
R2 objects. That is right for an abandoned give flow and fatal for an estate: a batch is prepared
over days and every photo in it is unattached until the day it is submitted. Without a change, a
giver's second evening would find the first evening's work gone.

The fix is `photos.retain_until`, a column on the row itself, rather than a `NOT EXISTS` join
against `upload_batch_photos`. The sweep's predicate stays single-table, so its correctness never
depends on a join across two tables written by two different code paths where the default on
disagreement is deletion. It also buys reclamation for free: cancelling or expiring a batch clears
the column and the existing, already-backup-guarded sweep collects the bytes on its next run. No
second implementation of R2 deletion, which is the code least worth writing twice.

Identity, grouping and ordering are a separate table (`upload_batch_photos`) precisely because they
are draft-workspace facts. `photos` is read by the feed, moderation, the image route and the share
card, and none of them should ever learn that batches exist.

**Draft previews need no new route.** `GET /i/:id/:variant` already serves an unattached photo to
its owner's token and 404s everyone else (`routes/images.ts`). A bulk-specific read route would
have been a second access-control implementation for the same bytes.

## What bounds a batch (there is no admission code)

A Turnstile token is single-use and expires in 300 seconds. Mounting `turnstile()` on the bulk
routes would mean one challenge per photo — three hundred challenges for a hundred-item estate. And
the ordinary per-IP daily ceilings cannot help either: 20 listings and 60 uploads a day exist
because there is no account to ration against, which is exactly the thing a bulk caller does have.
Inheriting them would refuse the 61st photo of a 300-photo batch.

This feature's first answer to that was a **grant**: an allowance row minted by an operator, whose
id the giver pasted into an "Admission code" field on `/bulk/new` and every write then carried as
`X-Bulk-Grant`. **It is gone** (`20260908094215_bulk_drop_grants.sql` drops the table). It made the
first step of giving away a houseful of keepsakes "wait for a human to issue you a code", for a
bound that a per-owner ceiling already provides. Two things replace it, and between them nothing the
grant bounded is unbounded now:

- **Per batch** — `BULK_MAX_ITEMS_PER_BATCH` / `BULK_MAX_PHOTOS_PER_BATCH`, enforced by
  `routes/bulk.ts` as *a predicate on the item and photo inserts themselves*
  (`AND (SELECT COUNT(*) …) < ?`), so a full batch refuses inside the same transaction that would
  have written the row and two concurrent creates at the boundary cannot both pass. Because these
  vars can never exceed the contract's `MAX_BATCH_ITEMS`/`MAX_BATCH_PHOTOS`
  (`test/bulkCaps.test.ts` asserts that from the real config), anything admitted is something a
  submission can still publish — the "400s *after* the work" failure the caps exist to prevent.
- **Per owner per day** — `bulk_owner_usage`, one row per owner per day, which the grant always sat
  under anyway and which (unlike a per-batch grant) survives a giver starting a second batch. Its
  third column, `suggestions_used`, is new: cover suggestions had no ceiling outside the grant, and
  a vision call costs real money.

`POST /api/bulk/batches` now carries `ownerAuth({ createIfMissing: true })`, the same as
`POST /api/listings` and `PUT /api/photos`. Starting a batch became a giver's possible *first*
request the moment the operator step went away, and a 401 there would have been this removal's own
footgun.

**Say the quiet part:** `turnstile()` soft-passes whenever `TURNSTILE_SECRET` is unset, which is
every local run and every test. The challenge is therefore *not* what bounds a batch. These D1
counters are. They are exact guarded updates, never KV — the KV budgets are eventually consistent
by their own documentation and cannot be a lock.

**One guard was found broken while removing the grant, and it is the shape `AGENTS.md`'s table
collects.** The `bulk_owner_usage` debit was an upsert whose ceiling lived in
`ON CONFLICT … DO UPDATE … WHERE`, with a comment claiming that guard covered the insert branch
too. It does not — `ON CONFLICT` guards only the update, so an owner's *first* write of a day was
admitted whatever the ceiling said. It never showed because the grant's own `> 0`-guarded `UPDATE`
ran in the same transaction and refused first; removing the grant removed the thing covering for
it. `test/bulkCeilings.test.ts`'s exhausted-allowance case is what caught it, and the insert branch
now carries the ceiling as `SELECT … WHERE ? > 0`.

## Exactly once, under retries

The submission runner must never create two listings for one draft, and a Worker can be evicted
between any two statements.

Three independent layers say no, and any one of them is sufficient:

1. The **claim** — `UPDATE upload_batch_items SET listing_id = ? WHERE id = ? AND listing_id IS
   NULL AND revision = ?`. The revision half is what "submit the revisions I reviewed" means: an
   edit landing between review and submit loses.
2. The **guarded insert** — the listing is inserted by an `INSERT ... SELECT ... WHERE` that fires
   only if this runner won that claim *and* every photo is still this owner's and still unattached.
   The photo half is what stops two submissions each attaching the same bytes.
3. The **partial unique index** `upload_batch_items_listing`, which is the one that survives someone
   rewriting the runner without reading this page.

The whole group is one `env.DB.batch()` — a single transaction, and the only such primitive this
Worker has.

**There is no compensating delete anywhere, and that is not an oversight.** The obvious way to make
a multi-step create atomic is to insert, check, and delete the listing if a later step disagrees.
`photos.listing_id` carries `ON DELETE CASCADE`, so deleting a just-inserted listing deletes the
photo rows attached to it — on this path those are the giver's draft photos, and their R2 bytes
would then be referenced by nothing and swept by nothing. Every guard is a precondition on the
insert, never a rollback after it.

**R2 and D1 are genuinely not one transaction**, and no design fixes that. What the reserve-then-
store shape buys is that the damage is bounded to "the same key, rewritten" — a retried upload
reuses its reserved photo id and its deterministic R2 keys — never "two photos, two charges".

## Moderation is unchanged, and paced

Every submitted item runs the ordinary pipeline: the contact-info check on title and story, the
aspect check, Llama Guard on the text, and both stored variants of every photo through the vision
model. Nothing about bulk relaxes a moderation rule, and the runner copies no moderation outcome
into its own tables — a submitted item's listing carries its own status, read from
`GET /api/me/listings` like any other. A second state machine racing the real one is how a listing
ends up "approved" in one place and `pending` in another.

Pacing is the part that needed a decision. A hundred items at three photos each is six hundred
vision calls plus a hundred text calls. The runner therefore works a bounded number of items per
invocation and re-arms, rather than trying to finish a submission in one pass, and the cron takes at
most one operation per owner per pass so one estate cannot monopolize recovery.

Bulk-created listings deliberately **skip the create-time embed**. `searchIndexRetry` already
re-embeds approved listings with no vector, hourly, so a bulk listing gets its vector after approval
instead of at creation. The cost is up to an hour of FTS-only search on a listing that is not public
yet anyway; the benefit is that one estate cannot spend the global `EMBED_DAILY_BUDGET` in a single
submission.

**What is not paced, and should be said plainly:** `moderationRetry` is still a sequential
`LIMIT 50` FIFO over everything `pending`. A 42-item submission will sit ahead of ordinary givers
for a few passes. The fix is a per-owner cap per pass, and it is a change to the queue every listing
in the product depends on — it belongs in its own change with its own guard test, not hidden inside
this feature.

## The web workspace

`apps/web/src/features/bulk/useBulkWorkspace.ts` is the one hook every screen under
`app/bulk/[batchKey]/` shares (via `BulkWorkspaceContext.tsx`, mounted once in that route's
`_layout.tsx` — the same "thin `useReducer` + effect pair" shape `batchStore.ts`'s own header
asked for). It wires the four fixed modules — `batchStore.ts`'s reducer, `storage.ts`'s IndexedDB
persistence, `uploadQueue.ts`'s upload pipeline, `src/api/bulk.ts`'s typed client — into the
operations the screens call, and adds nothing to any of the four: every local mutation is one of
the reducer's own existing actions.

Two facts worth knowing before touching it:

- **Every item save resends the item's whole `fields`.** `PUT /api/bulk/batches/:id/items/:id`
  overwrites `title`/`story`/`category`/`aspects` with exactly what `fields` carries — unlike
  `room_label`/`lot_label`, an omitted key is not "leave unchanged" (`apps/api/src/routes/bulk.ts`'s
  handler). A save that only changes which photos belong to an item still sends that item's full,
  current `fields`, or it would silently blank the story next to the photo change. Broken
  deliberately once to check this: sending `{}` instead on a photo-only regroup produced `Object
  {}` where the test expected `{title: "Blue mug", story: "A gift from Nan.", aspects: []}`.
- **"Human chose this" markers exist only client-side.** Neither `DraftItemFields` nor
  `BulkDraftItem` has anywhere to record "the giver typed their own title" or "the giver picked
  this category on purpose" (issue #155's rule, reimplemented for a draft item shape that predates
  it) — see `src/features/bulk/itemMarkers.ts` and the product-decisions row for why that is a
  `localStorage` side table and not a change to either fixed module. A late-arriving suggestion
  checks the marker before ever touching `title`/`category`; a manual "Suggest again" always
  bypasses the automatic-attempt dedup (`force: true`) so a giver's retry is never silently a
  no-op. Both were broken and watched fail: removing the dirty-title check let a stale suggestion
  overwrite `"Nan's blue mug"` back to `"Blue mug"`; removing `force` left a manual retry's
  `appliedSuggestionPhotoId` at `null` after an earlier automatic attempt had already failed for
  the same cover.

Screens: `app/bulk/index.tsx` (every batch this device knows, "Start a new batch"), `app/bulk/
new.tsx` (name/email/country-postcode/shared-story, plus a local-only pickup-deadline
reminder — see below), `app/bulk/[batchKey]/photos.tsx` (add + explicit "group as one item" /
"one item per photo" + per-photo cover/remove, no drag required for anything), `.../review.tsx`
(one card per item — compact list on desktop, one expanded card with Prev/Next on a phone — plus
"apply to selected" for room/lot labels and the shared-story context, with an exact before/after
preview and a 2,000-character refusal before anything is written), `.../submit.tsx` (select ready
items, one age check for the whole submission, separate saved/pending/live/failed counts). `app/
mine/index.tsx` gained a "Give several items" entry and a private "Estate batches" section listing
this device's draft batches.

**The pickup deadline is local, not a wire field.** It has no field in `CreateBatchInput` at all —
it is a personal reminder in `localStorage` (`pickupDeadline.ts`), on purpose: this feature does not
promise every item goes live together or before any date, and a client-invented wire field would
have implied otherwise.

**The email is saved on this screen, not on another one.** `/bulk/new` used to end with a
paragraph and an "Add your email →" link to `/mine/email`, which asked someone about to spend an
evening photographing a house to leave the form first. The field now sits inline, directly under the
batch name it pairs with (a batch is found again by name, and reachable from another browser only by
email), and saves through the same `POST /api/me/email` that screen calls. It runs *after* the batch
is created, because that route 401s a device with no `owners` row and `POST /api/bulk/batches` is
what creates one; the batch's client key is minted once per visit, so a refused address leaves the
giver on the form and pressing again retries the email against the same batch rather than starting
a second one.

## What is not built

Stated so nobody reads silence as done:

- **Never driven from a real browser.** Every screen above has a Jest render/interaction test
  against a mocked workspace or a mocked API — no Playwright pass, no screenshot, no person's phone.
- **My Keepsakes' private batch filter** (a toggle over the ordinary listing groups) and **per-item
  request counts** surfaced specifically from a batch context — a submitted item becomes an
  ordinary listing and already shows up in Mine's existing groups with its existing request-count
  UI, but nothing on the batch screens links forward to that beyond the plain fact that it happens.
- Batch-level observability. No Observatory panel, no digest line, no operation-age metric — so a
  first pilot run has to be watched by hand.
- Fairness in the moderation queue (above).
- Everything the feature plan already defers: CSV import, automatic grouping, public estate
  collection pages, printable lot labels, collaborators, pickup scheduling, prices, reservations.

## Status

**2026-09-08 — API and schema landed on a branch. Not deployed, not driven from a browser.**

What was actually run, and what it proves:

| Check | Result |
|---|---|
| `pnpm --filter @keepsake/api test` | 70 files, 695 passing, 3 skipped (the pre-existing `REAL_AI` gate) |
| `pnpm lint` | 0 errors, 61 warnings — all the zod const+type idiom |
| `pnpm -r typecheck` | clean |
| `node tools/preflight/preflight.mjs` | every check passes except `lfs-pointers`, which fails in an agent container because git-lfs is not installed |

Five guards were deliberately broken and watched fail, then restored, per this
repo's rule that a passing test is not evidence:

1. Raising `BULK_MAX_ITEMS_PER_BATCH` past the contract's `MAX_BATCH_ITEMS` —
   `expected 120 to be less than or equal to 100`.
2. Removing the `retain_until` predicate from the orphan sweep — a retained
   photo's row was gone, and a live batch's photo lost its retention.
3. An unconditional allowance debit, dropping the guard on the counter.
4. `owner_id` dropped from the batch fetch.
5. `bulkUploadEnabled` forced true.

Two defects were found this way rather than by reasoning, and both are worth
keeping in mind because they are the same shape as the table in `AGENTS.md`:

- **The cascade guard caught a foreign key with no delete behaviour.**
  `test/cascadeDelete.test.ts` enumerates from the live schema, so it saw a
  table nobody had told it about. Left as written, deleting a listing would
  have returned its draft to "never submitted" and the runner would have
  republished it.
- **The claim writes a foreign key to a listing that does not exist yet.**
  SQLite checks a non-deferrable foreign key immediately after the offending
  statement, not at commit, so the claim failed before its paired insert ever
  ran — on every bulk create. The fix is `PRAGMA defer_foreign_keys = ON` for
  that one transaction. A sqlite check run beforehand had missed it entirely,
  because the scratch table it used carried no foreign key on that column:
  a check that could not have failed.

And one near-miss worth recording. The end-to-end submission test asserted
`approved` and got `pending`, because its seeded photos had R2 keys with no
bytes behind them and `moderatePhotoVariant` fails closed on a missing object.
Relaxing the assertion to `pending` would have gone green and left the suite
permanently documenting a broken feature as working. The fixture was fixed
instead.

**What has NOT been done, and what that means:** nothing here has run against
`workerd` end to end, nothing has been deployed, and `BULK_UPLOAD` is `"0"`
everywhere except preview. No person has used this feature — the web workspace
below exists now, but only Jest has driven it.

**2026-09-08 — the web workspace landed on a separate branch. Screens exist; still nobody's
driven them from a browser.**

| Check | Result |
|---|---|
| `pnpm --filter @keepsake/web test` | 83 files, 681 passing |
| `pnpm lint` | 0 errors, 62 warnings — all the pre-existing zod const+type idiom, none new |
| `pnpm -r typecheck` | clean |
| `node tools/preflight/preflight.mjs` | every check passes except `lfs-pointers` (same agent-container limitation as above) |

Seven guards were deliberately broken and watched fail, then restored — see "The web workspace"
above for the two most load-bearing ones written out in full:

1. `dispatchSync` reverted to a plain `dispatch()` (dropping the synchronous mirror into
   `stateRef.current`) — four workspace tests failed, e.g. `expect(outcome?.ok).toBe(true)` /
   `Received: false`, because every grouping helper that dispatches-then-immediately-saves read a
   stale, pre-dispatch state.
2. An item save sending `{}` instead of the item's current `fields` on a photo-only regroup —
   `Object {}` where `{title: "Blue mug", story: "A gift from Nan.", aspects: []}` was expected.
3. A late suggestion overwriting a giver-typed title unconditionally — `Received: "Blue mug"`
   where `"Nan's blue mug"` was expected.
4. `sourcePatchesForDetachment` skipped for `planGroupAsOneItem` — a photo moved into a new group
   stayed listed on its old item too; `oldPatch?.photoClientIds` came back `undefined` where
   `["photo-1"]` was expected.
5. The 2,000-character shared-story guard in `previewSharedStoryApplication` disabled — a
   nearly-full item's preview stopped being marked `skipped`.
6. `MAX_PHOTOS` per item raised by one in `planGroupAsOneItem` — six photos grouped into one item
   with no refusal, where the test expected one.
7. The manual-suggestion-retry `force` flag removed — a giver's own "Suggest again" after an
   automatic attempt had already failed for the same cover became a silent no-op;
   `appliedSuggestionPhotoId` stayed `null` where the retry's own cover id was expected.

**2026-09-08 — the admission code removed, and the email moved onto the form that needs it.**

Kiarash asked for both from his phone, looking at `/bulk/new` on the live-ish site: the admission
code had to go, and "Add your email" was a link that took him to another page instead of letting
him add an email, sitting at the very end of the form and off-brand.

What changed:

| | |
|---|---|
| Removed | `bulk_grants` (dropped by `20260908094215_bulk_drop_grants.sql`), `requireGrant()`, `src/bulk/grants.ts`, `POST /api/admin/bulk/grants`, `BULK_GRANT_HEADER`/`BulkGrantSummary`/`AdminMintBulkGrantInput`, `BULK_GRANT_TTL_HOURS`, the web's `lib/bulkGrant.ts`, the `?grant=` link handling, and the workspace's whole `grantId` plumbing |
| Added | `src/bulk/usage.ts` (the `bulk_owner_usage` debits, one guarded statement each), `bulk_owner_usage.suggestions_used` + `BULK_OWNER_DAILY_SUGGESTIONS` (225), the per-batch caps as predicates on the item/photo inserts, `ownerAuth({ createIfMissing: true })` on `POST /batches`, an inline optional email field on `/bulk/new`, and an Observatory **Usage today** panel (with `owners_at_limit`) where the Grants panel was |

What was actually run, and what it proves:

| Check | Result |
|---|---|
| `pnpm --filter @keepsake/api test` | 77 files, 768 passing, 3 skipped (the pre-existing `REAL_AI` gate) |
| `pnpm --filter @keepsake/web test` | 82 files, 686 passing |
| `pnpm lint` | 0 errors, 60 warnings — all the pre-existing zod const+type idiom |
| `pnpm -r typecheck` | clean **except** one pre-existing failure this change did not cause and did not fix: `app/bulk/[batchKey]/photos.tsx` uses `icon="star-outline"`, which #264's Ionicons subset (7 glyphs) does not include. It is red on `main` at 51f2056 too, and it is a real product bug — that "make this the cover" button renders a missing glyph — but fixing it means regenerating a binary font subset, which belongs with whoever owns #264 |
| `node tools/preflight/preflight.mjs` | every check passes except `lfs-pointers` (git-lfs is not installed in an agent container); `backup-tables` re-derived the restore runbook's `--table` list and agrees `bulk_grants` is gone |

**Not run: the Playwright suite.** `e2e/bulk.spec.ts` and `e2e/ux.spec.ts` were updated for the
removed field (and `e2e/support/bulk.ts`, which existed only to mint grants, was deleted), but the
run was stopped at Kiarash's request, so **no browser has driven `/bulk/new` since this change** and
the UX baseline frames in `docs/qa/baseline/` still show the admission code. Both of those need a
pass before this is believed.

Six guards were deliberately broken and watched fail, then restored:

1. The per-batch item cap dropped from the insert's `WHERE` — `expected 201 to be 429` on the
   eleventh item into a batch capped at ten.
2. The per-batch photo cap dropped the same way — `expected 201 to be 429`.
3. `ownerAuth({ createIfMissing: true })` reverted to a plain `ownerAuth()` on `POST /batches` —
   `expected 401 to be 201` for a device whose first ever request is starting a batch.
4. The usage debit's insert-branch ceiling loosened back to what it was — `expected 201 to be 429`
   with the daily photo allowance at zero.
5. `/bulk/new`'s per-visit client batch key minted per press instead — the retry after a refused
   email started a second batch (`Expected: "batch-…-if2bx5r1" / Received: "batch-…-q9hmmro3"`).
6. The Observatory's `owners_at_limit` compared against a number no owner can reach —
   `expected +0 to be 1`.

And one defect was found this way rather than by reasoning, the same shape as `AGENTS.md`'s table:
**the `bulk_owner_usage` upsert's ceiling never applied to an owner's first write of the day.**
`ON CONFLICT … DO UPDATE … WHERE` guards only the update branch; the comment above it claimed
otherwise. It could not be observed while the grant existed, because the grant's own guarded
`UPDATE` sat in the same transaction and refused first — so removing the admission code is what
exposed it, and the exhausted-allowance test is what caught it. Fixed by putting the ceiling on the
insert branch too (`SELECT … WHERE ? > 0`).

**Follow-up on the same day, from Copilot's review of #269: a 429 with `Retry-After` no longer
means one thing.** `src/api/bulk.ts`'s `classifyBulkError` treated *any* `Retry-After` as
`"throttled"`, which `uploadQueue.pauseFor` sleeps through — correct while the only such 429 was the
router's per-minute burst brake. The per-owner daily ceilings answer 429 with
`secondsUntilMidnightUTC()`, up to 86,400, so a giver hitting today's photo limit would have parked
the whole queue until UTC midnight with no failed tile and nothing on screen to say why. That was
reachable before this change too (the ceiling has always answered that way) but only *past* an
exhausted grant, which normally refused first; removing the grant makes it the ordinary path.

The split is now by size — `MAX_PAUSE_SECONDS` (300), comfortably above the burst window and far
below any daily ceiling. It is a client-side policy about what a giver will sit through, not a
mirror of a server constant: the API still says exactly when the ceiling lifts. Two tests pin it
(`test/api/bulk.test.ts`'s boundary case, `test/features/bulk/uploadQueue.test.ts`'s "fails the
photo rather than pausing for hours"), and both were watched fail with the old rule restored —
`expected false to be true` on the queue pausing, and the 33,000-second 429 classifying as
`throttled`.
