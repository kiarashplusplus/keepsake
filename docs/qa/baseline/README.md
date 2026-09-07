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

## Known: the frames are not yet byte-stable between runs

Re-capturing with no code change currently rewrites about eight of the 74
frames. The cause is identified: `src/ui/Print.tsx` drops each card onto the
table with a Reanimated `withSpring` on mount, and `page.screenshot()`'s
`animations: "disabled"` only freezes CSS animations, not that one — so a
capture can land at any point in the spring and the card's tilt and scale
differ. Measured between two consecutive runs of the same commit:
`feed-cards` 21–26% of pixels, `mine` 6–10%, `dark-mine` 8%, the rest under
2%. The first version of `support/shots.ts` was worse (twelve frames, up to
32% on the dark item page); waiting out `expo-image`'s placeholder fade —
`PHOTO_FADE_MS` in that file — fixed the image half of it.

Nothing here compares images, so this costs nobody a red build; what it costs
is a noisier `git diff` than it should be when you refresh the set. The fix is
to wait for visual stability before capturing — screenshot, wait, screenshot
again, and only capture once two consecutive frames are identical, the same
thing Playwright's own `toHaveScreenshot()` does internally. That belongs in
`settle()`, and it is the next change to make here.

## Two rules inherited from `../README.md`

- **Never `fullPage`.** These are viewport shots. A full-page capture of a page
  nobody could scroll looked perfect for a week while M0's scroll bug shipped.
- **Commit the file; don't link a URL.** This repository is private, so
  GitHub's image proxy renders an external image as a broken thumbnail. A
  committed file referenced by path is the only thing that shows up in a pull
  request body.
