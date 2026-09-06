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
