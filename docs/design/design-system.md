# Design system

Status: `[IN PROGRESS]` (tokens + contrast test landed in M0; primitives are M0–M2).

`packages/tokens` (plain TS constants, subpath exports `/colors /spacing /radii /typography
/motion`) plus `apps/web/src/ui` (the primitives). "Warm keepsake box" feel: story excerpt in
italic serif on every card, a breathing wax-seal while a listing is under review, paper grain and
warm shadows in both modes.

## Colors

Three-way rule ported from Bayan: `accent` (decorative — fills, buttons) / `accentText`
(readable on the page background) / `onAccent` (readable on the accent color itself). Unlike
Bayan's fixed gold ink, Keepsake's terracotta **flips lightness across light/dark** so `onAccent`
stays legible in both — `#96401F` on cream, `#F0A283` on near-black. Every text token is checked
against every ground token by `packages/tokens/test/contrast.test.ts` (WCAG AA, ≥4.5:1); a token
that regresses contrast fails `pnpm --filter @keepsake/tokens test`, not a design review months
later. Grounds are never pure `#000`/`#FFF` — dark mode's `bg` is `#171310`, a warm near-black.

## Typography

Fraunces (variable, `opsz` axis) for display text and the story itself; Inter for UI chrome.
`storyExcerpt` (Fraunces Italic, 17/24) is the one line repeated on every card — the single most
load-bearing token in the system, since it's what makes the feed feel like a collection of
stories rather than a marketplace grid. Logical properties only (`textAlign: "start"`,
`marginStart`/`marginEnd`) so RTL is a locale flip, not a rewrite, even though the product is
English-only today.

## Motion

`motion.ts`: `spring {damping:18, stiffness:180}`, `sealBreathMs 2400` for the wax seal,
`standardMs 300`. `MotionProvider` reads `prefers-reduced-motion` **once**, and `useMotion()`
returns already-folded tokens — durations zeroed, springs stiffened, the seal static. No
individual component re-checks the media query; the fold happens in exactly one place
(`motionSafe()`, tested directly in `contrast.test.ts`'s neighbor).

## Primitives (`apps/web/src/ui`)

`Text`, `Surface`/`Card`, `Button` (primary/secondary/ghost, 44px targets), `IconButton`,
`Input`/`TextArea`, `Chip`, `Sheet` (focus trap + Escape), `Toast`, `Skeleton`, `EmptyState`,
`PaperGrain` (`.web.tsx`, fixed full-screen `feTurbulence` SVG, 0.045 light / 0.07 dark,
`pointer-events: none`), `Seal` (the breathing mark), `ReadableWidth` (720 prose / 1100 grid),
`Turnstile` (`.web.tsx` real widget, native stub disables submit). `theme.tsx` and `prefStore`
are ported from Finderly's `frontend/src/design-system/theme.tsx` /
`frontend/src/utils/prefStore.ts`, extended to sync `color-scheme` and `theme-color`.

See also: [platform-differences.md](../platform-differences.md) for the web-specific traps
(shadows, `position: fixed`) this system has to route around today.

## v2 identity (2026-09-05) — SUPERSEDED by v3 below

The founder rejected this round ("too generic / too Claude" — see
`apps/site/screenshots/v2-about-390-light.png`, `apps/web/screenshots/v3-home-390-light.png`).
Kept here for the record; do not build against it. See "v3 — Polaroids on a table" below for the
current identity.

The concept: Keepsake is a lidded card box, not a SaaS product — a wax-sealed tag tied with
string, a torn deckle edge, a hand-set italic. One terracotta pill button, a bottle-green second
voice for links/labels, and a foil gold reserved for the seal keep any single color from doing
all the work, and Fraunces' `SOFT`/`WONK` axes are switched on for the first time (wordmark,
display, drop cap) instead of sitting at their defaults.

| Token | Light | Dark | Role | Contrast (light, on `bg`) |
|---|---|---|---|---|
| `ink` | `#241C12` | `#F5ECDC` | body text | 14.7:1 |
| `accent` (terracotta) | `#AB4726` | `#E08258` | the one pill, the seal | decorative |
| `accentText` | `#8C3A1E` | `#F3A97E` | links/labels on `accent` hue | 6.7:1 |
| `accent2` (bottle green) | `#1E4D3F` | `#5FA98C` | second voice: nav, eyebrows, rules | decorative |
| `accent2Text` | `#1E4D3F` | `#7FC4A8` | readable green text | 8.4:1 |
| `foil` (gold) | `#B8862E` | `#D9B155` | seal ring, ornaments | decorative only |
| `foilText` | `#7A5710` | `#E8C97A` | footer mark, readable gold | 5.7:1 |
| `rule` | ink @35% | cream @28% | hairline dividers, replaces pale borders | decorative |

Type: modular-ish scale, tight leading, negative tracking on display (`displayXl` 52/54, `-1.4`
tracking, `"opsz" 144, "SOFT" 40, "WONK" 1`). New tokens: `wordmark` (italic, full SOFT+WONK),
`dropCap`, `numeral` (96px ghost step numbers), `eyebrow` (spaced-caps Fraunces, low opsz,
replaces Inter all-caps). `radii` went square (`sm 4/md 8/lg 14`, new `tag: 6`), `pill` stays
reserved for the one primary button. `shadow.*` is now two offsets of the same color ("paper on
paper") instead of one blur. `motion` gained `liftMs`/`tagTiltDeg` for the one hover
micro-interaction (card lifts 2px, rotates 0.4°, like picking up a tag); both zero under
reduce-motion.

Surfaces: example cards are tags (radius `tag`, a punched-hole+string SVG, dashed rule instead of
a card border, torn-deckle `clip-path` dividers between alternating-tone sections). "How it
works" is a numbered list with oversized translucent numerals, not a 3-card grid.

**Checklist for `apps/web`** (tokens are additive/ready, not yet adopted there):
- [ ] Wordmark: apply `type.wordmark`'s `fontVariationSettings` (`AppHeader.tsx`, `Seal.tsx`'s "K")
- [ ] Card treatment: adopt `radii.tag` + `shadow.tag` for feed cards, add the punched-hole SVG
- [ ] Eyebrows/labels: swap `type.label` (Inter caps) for `type.eyebrow` where it reads as a section head
- [ ] Seal colors: ring in `foil`, disc in `accent`, mark in `onAccent` (matches the new OG seal)
- [ ] Adopt `accent2`/`accent2Text` for links and the "Mine" nav item so terracotta isn't the only color

## v3 — Polaroids on a table (2026-09-06)

**Concept, in two sentences.** Keepsake is objects photographed and laid out on a tabletop: every
listing is an instant-film print — white frame, black ink caption, a thick bottom border — taped
down at a few tilted degrees, and the one accent is a red rubber stamp ("NEW"/"GIVEN"/"HELD"/"ON
REVIEW") pressed slightly off true. Warm, human, a little messy, unmistakable at 200px — a family
sorting photos on a kitchen table, not a SaaS dashboard.

**The one architectural decision everything else follows from.** A photograph, once printed, does
not change colour when the room's lights go down — so almost nothing in `packages/tokens/src/colors.ts`
flips between light and dark. `ink` (`#1B1815`), `pencil`/`textSecondary` (`#5A524A`), `print`
(`#FBF9F4`), and the stamp red (`accent #C4341C` / `accentText #8A2113`) are **byte-identical** in
`colorsLight` and `colorsDark` — verified by a dedicated test in `contrast.test.ts` that asserts
every key except `TABLE_TOKENS` (`bg`/`table`/`tableEdge`/`surfaceSunken`/`overlay`/`shadow*`/
`lampLight`) is unchanged across the two objects. Only the table itself goes from kraft by day
(`bg #D2BC97`) to walnut at night (`bg #2B2119`, with `lampLight` a warm radial glow), plus the
`surface` chrome an input/sheet/chip/header is cut from (`#F1E6CC`, a lined index card — also
constant). Because ink never inverts, every screen's real content (headlines, forms, dashboard
rows) is wrapped in a `Card` (`src/ui/Surface.tsx`) or a `Print` (`src/ui/Print.tsx`) rather than
sitting bare on the table — see those two components' header comments, and `EmptyState`/
`give/_layout.tsx`'s `StepShell`, which each do this once so a dozen screens didn't have to. The
marketing site (`apps/site`) takes the simpler, more conventional path instead — its `ink`/`text2`/
`text3`/`surface` genuinely flip per theme, re-hexed to the same kraft/walnut palette — because it
has no literal "print" object framing every paragraph; only the stamp red and print white stay
constant there, matching "stamp red stays."

**Palette** (`packages/tokens/src/colors.ts`; ✓ = verified by `contrast.test.ts`):

| Token | Value | Flips? | Role | Contrast |
|---|---|---|---|---|
| `bg` / `table` | `#D2BC97` light, `#2B2119` dark | yes | the table itself | `ink` on light `bg` = 9.6:1 ✓ |
| `tableEdge` / `surfaceSunken` | `#B89D74` light, `#1C140F` dark | yes | vignette / skeleton fill, decorative only | — |
| `surface` | `#F1E6CC` | no | index-card chrome (inputs, sheets, chips, header) | `ink` on `surface` = 14.3:1 ✓ |
| `print` | `#FBF9F4` | no | the photograph's own frame | `ink` on `print` = 16.8:1 ✓ |
| `ink` | `#1B1815` | no | body/caption text | see above |
| `pencil` / `textSecondary` | `#5A524A` | no | secondary text on the print | on `print` = 7.3:1 ✓ |
| `textTertiary` | `#6C6150` | no | captions/metadata | on `print` = 5.8:1 ✓ |
| `accent` / `stamp` | `#C4341C` | no | decorative stamp fill (not text-safe) | — |
| `accentText` / `stampText` | `#8A2113` | no | the stamp's readable ink | on `print` = 8.7:1 ✓ |
| `onAccent` | `#FBF9F4` (=`print`) | no | label on the stamp/primary-button fill | on `accent` = 5.2:1 ✓ |
| `tape` | `rgba(255,236,160,.55)` | no | masking-tape corners | decorative |
| `foil` / `foilText` | `#8A6D3F` / `#5C4726` | no | aged small labels (e.g. step numerals ahead) | `foilText` on `print` = 8.4:1 ✓ |
| `focus` / `dangerText` | `#7A2515` | no | focus ring, error text | on `print` = 9.5:1 ✓ |

**Type.** Two faces, nothing else visible: **Fraunces** (variable, self-hosted, unchanged from v2)
for headlines/wordmark/story, pushed to a high `opsz` for display and low for prose; **Courier
Prime** (OFL, self-hosted at `apps/web/public/fonts/CourierPrime-{Regular,Bold,Italic,BoldItalic}.ttf`,
symlinked into `apps/site/.preview-fonts/`) for every caption/label/stamp/button/metadata line —
`type.eyebrow`/`type.label`/`type.caption`/`type.stamp` in `packages/tokens/src/typography.ts`.
`fontFamily.ui` is kept as an alias of the new `fontFamily.mono` so nothing importing the old name
breaks. Inter is gone entirely (not even a fallback) — the one sanctioned exception is form input
*text* (`Input`/`TextArea`), which the brief explicitly allows to be plain.

**Surfaces.** `radii.*` all collapsed to `2` (a print's almost-square corner, not a SaaS radius);
`shadow.*` moved from a symmetric drop to an offset-down-and-right cast plus a 1px inset edge
(`inset 0 0 0 1px rgba(0,0,0,.08)`), so a `Print`/`Card` reads as paper resting proud of the table.
`Button` is a stamped rectangle: filled stamp-red (primary) or filled ink with a cream label
(secondary), mono uppercase label, a small fixed rotation hashed from the label text so it's stable
across renders. Secondary was an *unfilled* 2px ink outline until issue #134 — the `print` fill
inside it measured 1.18:1 against the `surface` card it sits on, so it read as an empty field
rather than a control. The ink fill is 14.25:1 both for its label and against that card. `Chip` is an ink-outlined mono label, no pill. `Input`/`TextArea` are lined index
cards: `surface` fill, a 2px ink *baseline* instead of a boxed border (the baseline thickens and
turns stamp-red on focus). `Sheet` is an index card (square corners, shadow, no hairline) that
slides up from the bottom under the sheet breakpoint. `Stamp` (`src/ui/Stamp.tsx`, replacing
`Seal`) draws the red rubber-stamp mark with a doubled, semi-transparent outline to fake uneven
ink, and is the ornament behind every empty/idle/review state. `Print` (`src/ui/Print.tsx`,
replacing `TagCard`) is the recurring photo object: white frame, two translucent tape corners
(`TapeCorner`), a deterministic resting tilt.

**Layout.** The feed (`app/index.tsx`) is a tabletop: the hero (eyebrow/headline/deck/CTA) and the
search/filter row each sit in their own slightly-rotated `Card`, but the results grid itself sits
directly on the visible `KraftTable` (`src/ui/KraftTable.web.tsx`, replacing `PaperGrain` —
full-bleed fixed fibre-noise + vignette + lamp-light, ~8% opacity, now painting the table colour
itself rather than sitting as a layer over a flat fill). `ListingCard`/`MasonryGrid`
(`src/lib/masonry.ts`'s new `tiltDegForId`/`verticalOffsetForId`, pure and hash-based off the
listing id — same input always produces the same tilt/offset, and the existing column-assignment
functions/tests are untouched) place each print at a deterministic -3°..+3° lean with a small
per-column vertical jitter. The give flow's five steps and the review screen's every phase share
one `Card` from `give/_layout.tsx`'s `StepShell`, so the flow reads as filling out one index card.
The reviewing state is a face-down print bearing an "ON REVIEW"/"HELD" stamp with a slow restless
tilt; it flips face-up to a "LIVE" stamp on approval (a `scaleX` sequence), or swaps instantly
under reduce-motion.

**Motion** (`packages/tokens/src/motion.ts`; old names kept as aliases — `tagTiltDeg`→`tiltDeg`,
`sealBreathMs`→`reviewTiltMs`). New tokens: `dropMs` (350, a print's drop-onto-the-table entrance,
scale 1.03→1), `dropSpring`, `tiltDeg` (1°, how far a hovered print straightens), `tiltRangeDeg`
(3°, the full deterministic per-id lean range), `stampMs` (120, the stamp's press-down), and
`reviewTiltDeg`/`reviewTiltMs` (±1° over 3s, the one remaining loop). `motionSafe(reduce)` zeroes
every duration/loop and leaves `tiltRangeDeg` alone (a resting tilt is a static layout choice, not
an animation) — asserted in `contrast.test.ts`'s `motionSafe` block.

**OG image / favicon.** `apps/site/og/og-default.svg` redrawn as a taped, tilted print carrying the
wordmark/headline/stamp on kraft, regenerated to `apps/site/public/og-default.png` with
`npx -y @resvg/resvg-js-cli --font-file … og-default.svg og-default.png` (note: Courier Prime's own
name-table family is "Courier Prime" with a space — the SVG's `font-family` attributes must match
that, not the token name `CourierPrime`, or resvg silently falls back to its default font).
`apps/web/public/favicon.png` regenerated the same way from `apps/site/og/favicon.svg` (a tilted
print with a red stamp dot).

**Screenshots:** `apps/web/screenshots/v4-*.png`, `apps/site/screenshots/v4-*.png` (light + dark,
390 + 1280, home/item/give/give-review/mine/about).
