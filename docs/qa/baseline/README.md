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
| `feed*` | The table, a category chip, and a search with no answer |
| `item*` | An item page, the request sheet empty / filled / sent, the report sheet |
| `give-1`…`give-6` | Every step of the give wizard, including the autofilled title and the live stamp |
| `mine*` | The giver's own listings, a request they can choose, the choose sheet, the chosen state, the email screen |
| `recover*`, `withdraw-bad-link`, `not-found` | The screens on the end of a link |
| `admin*` | The token gate, the queue, the Hidden tab |

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
mean two captures are guaranteed byte-identical on every machine: Chromium's
own text rasterisation differs by build, and a capture run on a Chromium other
than the one this suite is pinned to can still move every frame on font
metrics alone — that is an environment mismatch, not a bug in the fixture, and
the fix is capturing from the pinned build, not chasing pixels here.

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
