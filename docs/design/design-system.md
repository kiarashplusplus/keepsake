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

## v2 identity (2026-09-05)

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
