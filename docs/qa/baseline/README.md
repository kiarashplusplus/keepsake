# The UX baseline

One viewport screenshot of every screen this product has, in the states worth
looking at, taken from the real local stack and committed. Refresh them with:

```sh
pnpm --filter @keepsake/web export      # the Worker serves this, not a dev server
pnpm --filter @keepsake/web e2e:ux
```

That writes `ux-mobile/` (390×844, the phone) and `ux-desktop/` (1280×800) as
JPEGs at quality 85, then `git status` shows exactly which screens moved. Review the diff by
looking at the files — that is the whole point; there is no assertion in this
directory.

## What it is for

The e2e suite proves the product *works*. Nothing in it can tell you the story
is too long at 390px, that the request sheet crowds its own send button, or
that the dark table went muddy — those need eyes, and eyes need a before and
an after. This is the before.

It is also the cheapest way to review the deployed-looking product without
deploying: `wrangler dev` serving the real static export through the Worker's
`[assets]` binding is the same arrangement production runs, and none of it is
behind Turnstile (the Worker runs with no `TURNSTILE_SECRET` and the export
carries no site key, so every submit button is reachable — see
`apps/web/e2e/support/global-setup.mjs`).

## What it is not

**Not a pixel gate.** Nothing compares these images, and CI does not run the
capture. Font rasterisation, GPU compositing and Chromium build differ between
a laptop and a GitHub runner, so a byte-comparison here would fail for reasons
that have nothing to do with the design — the classic check that goes red so
often everyone learns to ignore it. If that changes, the honest form is
Playwright's own `toHaveScreenshot()` with a per-platform snapshot suffix and a
tolerance, not a diff of these files.

**Not an archive.** Same rule as `../README.md`: when a screen changes, the
baseline changes with it in the same pull request. Old frames live in git
history, not here.

## What is in it

Both projects capture the same states, `ux-mobile` also carries the `dark-*`
set (one look at the palette is evidence; two are bytes):

| Prefix | Screens |
| --- | --- |
| `welcome`, `consent-banner` | The two things a stranger sees before the feed |
| `feed*` | The table, a category chip, a search with no answer, the location controls in force, and a radius with nothing inside it |
| `item*` | An item page, the request sheet empty / filled / sent, the report sheet, one keepsake that has already been given, and the not-found page a link to a keepsake that is no longer public lands on |
| `give-1`…`give-6` | Every step of the give wizard, including the autofilled title and the live stamp |
| `mine*` | The giver's own listings, one nobody has asked for (with its category picker and its delete confirmation), one already given, one a moderator rejected and one reports took down, a request they can choose, the choose sheet, the chosen state, the email screen |
| `bulk*` | The estate workspace: an empty batch list, a started batch, photos, review, submit |
| `recover*`, `confirm-bad-link`, `withdraw-bad-link`, `not-found` | The screens on the end of a link |
| `admin*` | The token gate, the stats strip and its report-pressure section, the queue and its tabs, the Hidden tab (including the card three reports took down, with their rows on it), the Rejected tab, a selection and its bulk toolbar, the reject sheet, and both halves of the Observatory |

Six of those states exist only because the fixture goes out of its way to
reach them, and each is still reached through the product's own routes rather
than by rendering a screen the product cannot produce:

- **A radius with nothing in it.** Every keepsake this suite seeds is in
  eastern Massachusetts, so no radius a visitor can pick around any of them
  ever came back empty, and the feed's third empty state
  (`src/features/feed/emptyState.ts`'s `radius`) was unreachable and
  unphotographed. `e2e/support/global-setup.mjs` seeds a fourth real postcode
  3,000 miles away (99501, Anchorage) that nothing is ever listed in, and the
  frame is taken at `/?country=US&postal=99501&radius_mi=10`.
- **A keepsake already given.** `demoCatalog.ts`'s `DEMO_GIVEN_LISTING` is
  created like every other one and then marked given through
  `POST /api/listings/:id/given` — the same call the dashboard's button
  makes. The feed is `status = 'approved'` only, so it never reaches the
  table and no existing frame changes because it exists.
- **An empty estate batch list.** A freshly minted owner token is a device
  the server has never seen, which `app/bulk/index.tsx` renders as an empty
  list rather than an error — the ordinary first visit to `/bulk`.
- **A keepsake three strangers reported.** Every hidden listing this fixture
  had was hidden by an admin, so `QueueItemCard`'s `Reports (n)` section — the
  rows a moderator reads before deciding anything — had only ever been
  photographed saying "None.", and `StatsStrip`'s report-pressure section
  (#89) only ever at zero. `demoCatalog.ts`'s `DEMO_REPORTED_LISTING` is
  created and approved like any other and then reported three times from three
  addresses through `POST /api/listings/:id/reports`, which is the public
  route the item page's report sheet fires; the third crosses
  `REPORT_AUTOHIDE_THRESHOLD` and the product hides the listing itself, with
  no admin involved. It is `hidden`, so it never reaches the feed. Two more
  reports go on `Twelve jazz records`, which stays live and one short of the
  same fate — the "One report away" half of that section, and the reason the
  keepsake it names is still on the table in every feed frame.
- **A keepsake a moderator rejected.** The reject sheet was in the baseline
  and its consequence was not: `mine/[id].tsx` shows the giver
  `MODERATION_REASONS[reason]` — the giver-facing sentence, not the sheet's
  short chip label — and #362 kept that Status section for exactly this case.
  `DEMO_REJECTED_LISTING` is rejected through `POST
  /api/admin/listings/:id/reject`, the same call the sheet makes, with a story
  that really does carry a phone number so `contact_in_story` is the honest
  reason. It is also the only thing the queue's Rejected tab has ever had in
  it.
- **A link to a keepsake that is no longer public.** `GET /api/listings/:id`
  answers only for `approved` and `given`, so the reported listing above is a
  404 to a stranger holding a share link that worked last week — which
  `app/item/[id].tsx` draws as an idle stamp and a way back, not an error.
  Taking `item-not-found` against a real hidden listing rather than an invented
  id is what makes it the product's answer to a stale link.

Sheets that would change the fixture are opened and then dismissed: the
category picker, the delete confirmation, the admin reject sheet. Both
projects run against one database, so a capture that confirmed any of them
would leave the other project photographing a different product.

What still has no frame, and why: the queue's **Needs review** and
**Pending** tabs are photographed empty, because `MOCK_AI=1` decides every
listing this suite seeds in milliseconds and always approves it. Both states
are the moderation pipeline holding a listing back — `held_for_review`, or a
retry budget running out — and neither is reachable through any route a
visitor or an admin can call, so producing one would mean writing a status
into D1 that the product did not put there. That is the line this directory
does not cross (see the spec's header). An empty **Needs review** is also the
state a real day is usually in, which is why `admin-queue-empty` is worth its
own frame.

This supersedes `apps/web/scripts/screenshots-v{2,3,4}.mjs` for new work — those
drive Chrome over CDP from a hardcoded macOS path and write to an untracked
directory. They are left in place because `docs/design/design-system.md` and
`docs/runbooks/launch-audit.md` cite what they produced; nothing new should
use them.

The content is fixed on purpose — the same six keepsakes, the same two
requests, the same words — so a diff between two runs is a design change and
nothing else. That catalogue is `apps/web/e2e/support/demoCatalog.ts`; the
capture itself is `apps/web/e2e/ux.spec.ts`.

## Why JPEG

Measured, not assumed: the same set is ~20 MB as PNG and ~3 MB at quality 85
(a 1280×800 feed frame goes 541 KB → 101 KB). These are meant to be refreshed
every time a screen changes, and every refresh writes fresh binary blobs into
history — 20 MB a time is how a QA directory becomes something people delete
rather than maintain. What that costs is exact pixel fidelity, which nothing
here is judged on: contrast is `a11y.spec.ts`'s axe run, and a one-pixel colour
question belongs in the running app.

## Fixed: three causes that used to make the frames churn between runs

How many frames a re-capture used to rewrite with no code change is
deliberately not written down as a number here — it went stale twice (16 of
76, then 77 total, while the directory quietly grew to 89). Compare two runs
instead: `ls docs/qa/baseline/ux-mobile | wc -l` and the `ux-desktop` twin give
the current counts, and `git status` after a re-capture shows exactly which
files moved.

Fixed here means the three causes below no longer move a frame. It does not
mean two captures are guaranteed byte-identical on every machine: text
rasterisation belongs to the host, and a capture taken somewhere other than
where the committed set was taken moves every frame on font metrics alone —
an environment mismatch, not a bug in the fixture, and not something to chase
pixels over here.

**It is the host, not the Chromium build.** This paragraph used to say the
build, and so does `AGENTS.md`; measured on the container this set was last
refreshed from, that is wrong. The pinned headless shell (1243, Chromium 153)
and the older build that ships in the image (1194, Chromium 141, symlinked
under the pinned name the way `AGENTS.md` describes) produce **byte-identical**
frames — 0.00% of pixels differ. Both differ from the set committed before
them on 2–4% of pixels, on every frame, with no layout change anywhere: same
line breaks, same wrap points, same element positions, only the antialiasing
of the glyphs. So installing the pinned build is not what makes a refresh
comparable; capturing from the same machine as last time is, and no rule here
can guarantee that. Refresh the whole set in one run, and read the diff as a
design diff only where the design actually moved.

**Fixed — the mount spring.** On web, `Print.web.tsx` drops each card onto the
table with a CSS animation (`Stamp.web.tsx` and `Skeleton.web.tsx` are the same
shape — added in #265, alongside `Print.web.tsx` which already existed), and
`page.screenshot()`'s `animations: "disabled"` only freezes *some* of that, so
a capture could land anywhere mid-drop. `support/shots.ts` now waits for two
consecutive identical frames before capturing, and both capture projects run
under `prefers-reduced-motion: reduce`, where `motionSafe()` starts `drop` at
its settled value instead of animating to it. Note what `reduce` deliberately
does *not* change: `tiltRangeDeg` is passed through untouched, so the prints
are photographed at the same angles a visitor sees. What it drops are
transients — the drop-in, `expo-image`'s cross-fade, and the wobble — every one
of which resolves to the same resting pixels it was heading for. The baseline
shows the design, not a reduced-motion variant of it. (The Reanimated
`withSpring`/wobble this paragraph used to describe is `Print.tsx`'s and
`Stamp.tsx`'s *native* implementation — this capture never runs against it;
see #275.)

**Fixed — the ids.** Every screen that renders a list of prints —
`feed-cards`, `feed-category`, `feed`, `mine`, `mine-detail-*`,
`admin-hidden`, `dark-mine` — used to move on every re-capture even with the
catalogue's titles, stories, categories and postcodes held fixed.
`ListingCard` sets each print's angle from `tiltDegForId(listing.id)` and its
offset from `verticalOffsetForId(listing.id)` (`src/lib/masonry.ts`), both of
which hash the id, and the id used to be a ULID the API minted fresh on every
run — `support/demoCatalog.ts` wipes the database and re-seeds through the
real API every capture. `support/demoCatalog.ts`'s `PINNED_LISTING_IDS` now
rewrites each minted id to a fixed one immediately after creating it
(`support/demoDb.ts`'s `pinListingIds()`, a direct write into the same local
D1 file `wrangler dev` is serving from), so the hash input — and therefore the
tilt and offset — is the same on every run (#225). That is also why `item` and
the give-flow frames were never affected: `PhotoCarousel` passes a literal
`tiltDeg={-1.2}` rather than hashing anything.

**Not fixed, and measured: two things in the product that differ between two
runs on one host.** Both were seen while the reported/rejected frames above
were being added — the same commit captured twice, minutes apart, against
frames the change could not reach. The admin cards and the giver's dashboard
print relative times (`posted 2 min ago`, `[2 min ago] Spam`), and the second
capture project runs minutes after the first against one database, so those
lines are a function of when the run happened rather than of the design. And
`/mine`'s hand-drawn rule is redrawn per run: on two consecutive captures the
only pixels that moved in `mine` and `dark-mine` were that squiggle. Neither
is worth pinning today — a frozen clock would have to be threaded through the
Worker, and the rule is decoration — but they are why `git status` after a
re-capture can list a frame nothing in the diff touched. Read the images, not
the file list.

**Fixed — the four giver-request frames.** `mine-detail-requests`,
`-choose`, `-chosen` and `mine-email` used to be permanently stale: #188 holds
a request unconfirmed until the stranger clicks a link that exists only in an
email, so this harness could never produce one for the giver's dashboard to
show, and `e2e/ux.spec.ts` skipped that block outright. `support/demoDb.ts`'s
`confirmDemoRequests()` now writes the same two effects
`POST /api/requests/confirm` would have — `confirmed_at`/`status` on the
request, the count on the listing — directly into D1 right after
`support/demoCatalog.ts` sends the fixture's two asks, rather than adding any
confirm-token shortcut the real app could reach too (#240).

## Always capture through `pnpm --filter @keepsake/web e2e:ux`

That script exports the web bundle before it captures, and it is the only
supported way to refresh this directory. The Worker serves `apps/web/dist`
through its `[assets]` binding and nothing in the harness ever built it, so a
bare `UX_SHOTS=1 playwright test` photographs whatever export happens to be on
disk — another branch's, or one built before the change under review. That
failure is silent and it inverts the point of a baseline: you change a screen,
capture, and the frames come back identical.

It is not hypothetical. A capture run on a checkout whose `dist` was eleven
hours stale photographed an `/admin` that predated `aria-label="Queue status"`,
and the spec failed against a screen that was correct in the source it was
supposedly testing. `e2e/support/global-setup.mjs` now refuses to capture when
`dist/version.json` names a different commit than `HEAD`, or when any file
under `app/`, `src/` or `packages/` is newer than the export.

## Two rules inherited from `../README.md`

- **Never `fullPage`.** These are viewport shots. A full-page capture of a page
  nobody could scroll looked perfect for a week while M0's scroll bug shipped.
- **Commit the file; don't link a URL.** This repository is private, so
  GitHub's image proxy renders an external image as a broken thumbnail. A
  committed file referenced by path is the only thing that shows up in a pull
  request body.
