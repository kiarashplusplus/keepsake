# Platform differences (Web today; iOS/Android later)

> **Web-only today.** Keepsake ships web-only via Expo's static export; iOS/Android are a later
> flip on the same Expo SDK 57 + expo-router codebase (see the plan's "Platform" decision). This
> doc is adapted from Finderly's `frontend/docs/platform-differences.md` — a monorepo that
> already made the iOS/Android/Web jump and hit every trap below doing it — so that flip, when it
> happens, starts from lessons already paid for instead of re-discovering them. Everything here
> is either directly applicable today (web-only sections) or a heads-up for the day a
> `.native.tsx` file first appears in this repo.
>
> When you discover a new per-platform quirk, add it here.

---

## 0. How a platform-specific file is chosen (Metro resolution)

Metro picks the most specific extension for the current platform, in order:

| Platform | Resolution order |
| --- | --- |
| Web | `*.web.tsx` → `*.tsx` |
| iOS (future) | `*.ios.tsx` → `*.native.tsx` → `*.tsx` |
| Android (future) | `*.android.tsx` → `*.native.tsx` → `*.tsx` |

So: **`*.web.tsx`** is a web override (often a no-op or a DOM implementation, e.g.
`Turnstile.web.tsx`, `secretStore.web.ts`); a bare **`*.tsx`** is the fallback used everywhere
until a native variant exists. **Rule, ahead of the native flip:** when a platform file is
created, keep every exported symbol in sync across variants — a drift there is a *compile* error
on the other platform, not a runtime one, which makes it worse to discover late.

## 1. Shadows — prefer `boxShadow`

Historically three separate shadow systems (iOS `shadow*` props, Android `elevation`, web CSS
`boxShadow`). Under React Native's New Architecture, the **`boxShadow` style prop renders on iOS
and Android too**, so writing shadows as `boxShadow` strings now (`shadow.card`,
`shadow.sheet` in `packages/tokens/src/spacing.ts`) is the one-token-covers-all-platforms choice
— there is no reason to reach for the legacy per-platform props even before native ships. A black
shadow is invisible on a dark background on every platform; use the warm-tinted shadow tokens
rather than a plain black one.

## 2. Pressable (future native)

Not a web concern today — Keepsake uses `Pressable`/the DS `Button` directly. **Heads-up for the
native flip:** `facebook/react-native#44610` means `Pressable.onPress` fires unreliably on
Android under the New Architecture; Finderly's fix was swapping in
`react-native-gesture-handler`'s `Pressable` on Android only, inside the DS `Button`/`IconButton`
so call sites never see the difference. Revisit this the day an Android target is added — don't
wait for the bug to reappear first.

## 3. Keyboard vs. `position: fixed` — the composer lesson

The single most expensive lesson Finderly paid for on mobile web, condensed (full account:
`COMPOSER-KEYBOARD-POSTMORTEM.md` in that repo — ten PRs to root-cause): **inside a navigator,
`position: fixed` never means "the viewport."** A `Card`/navigator's animated container is itself
a containing block — even at rest, its `transform` (however inert) captures `fixed` descendants,
so a bar meant to hug the bottom of the screen is actually anchored to that transformed ancestor.
Layered on top, mobile Safari's keyboard resizes `window.innerHeight` in ways that make
`visualViewport` math built on `offsetTop`/`scrollY` self-certifying-wrong: the "error" the
correction computes reads 0 while the element is plainly off-screen, because the same flawed
formula produced both the measurement and the fix. WebKit bug #297779 makes this worse on iOS
26: `visualViewport.offsetTop` and `height` can remain stale after keyboard and scroll
interactions, so no JavaScript correction based on those values is reliable.

The fix that actually holds up: **do not fight `fixed` at all.** Render the bar in **normal
document flow**, at the bottom of a flex column sized against `100dvh` (or the equivalent), so it
moves with layout rather than being separately anchored and separately corrected. This sidesteps
both the containing-block problem and the layout/visual-viewport axis entirely, at the cost of
laying out the rest of the screen to leave room for it. Any Keepsake surface with an
always-visible bottom element on web (a sheet's action row, a future sticky composer) should
default to this pattern rather than `position: fixed`. The shared web `Sheet` follows this rule:
its overlay is an in-flow `100dvh` box and does not read or correct `visualViewport.offsetTop`.

## Quick symptom → cause index

| Symptom | Likely cause | Section |
| --- | --- | --- |
| Shadow looks different or missing per platform | using legacy `shadow*`/`elevation` instead of `boxShadow` | §1 |
| Native tap doesn't fire on Android (once native ships) | RN Pressable #44610 | §2 |
| A `fixed` bar is offset, jumps, or vanishes when the keyboard opens | fixed inside a transformed ancestor + viewport math built on untrustworthy `offsetTop` | §3 |
