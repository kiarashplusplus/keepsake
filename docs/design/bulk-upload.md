# Estate bulk upload

Status: `[TODO]` — API and schema only, and **nothing here has been driven from a browser**. The
web workspace does not exist. Read "What is not built" before believing any part of this is usable
by a person. The status line at the bottom is the one that is kept current.

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

## Admission: why a grant exists

A Turnstile token is single-use and expires in 300 seconds. Mounting `turnstile()` on the bulk
routes would mean one challenge per photo — three hundred challenges for a hundred-item estate. And
the ordinary per-IP daily ceilings cannot help either: 20 listings and 60 uploads a day exist
because there is no account to ration against, which is exactly the thing a bulk caller does have.
Inheriting them would refuse the 61st photo of a 300-photo batch.

So a **grant**: an allowance row, minted by an operator for the pilot, naming a finite number of
items and photos, bound to one batch on first use, extended (never refilled) by a fresh challenge.

It is deliberately **not a bearer secret**. The id travels in a plain `X-Bulk-Grant` header and says
only *how much*; who the caller is remains the owner token in `Authorization`, checked first. There
is no new secret material to leak into a log, a URL or an image request, and a leaked grant id is
worth nothing without the device token it is bound to.

Above the grant sits `bulk_owner_usage`, one row per owner per day. The grant is per-batch and
finite; this row survives both a new batch and a renewed grant, which is what makes "creating
another batch does not reset the allowance" true rather than merely intended.

**Say the quiet part:** `turnstile()` soft-passes whenever `TURNSTILE_SECRET` is unset, which is
every local run and every test. The challenge is therefore *not* what bounds a batch. These D1
counters are. They are exact guarded updates, never KV — the KV budgets are eventually consistent
by their own documentation and cannot be a lock.

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

## What is not built

Stated so nobody reads silence as done:

- **All of `apps/web`.** There is no batch workspace, no grouping UI, no "apply to selected", no
  cover picker, no My Keepsakes filter. The API is reachable and the product is not.
- Batch-level observability. No Observatory panel, no digest line, no operation-age metric — so a
  first pilot run has to be watched by hand.
- Fairness in the moderation queue (above).
- Everything the feature plan already defers: CSV import, automatic grouping, public estate
  collection pages, printable lot labels, collaborators, pickup scheduling, prices, reservations.

## Status
