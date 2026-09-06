# apps/site

Static marketing pages for Keepsake: `/about`, `/privacy`, `/terms`. Plain
HTML + CSS, no build step, no framework, no JavaScript beyond the six-line
inline theme-sync script in each `<head>`.

## Scope

This package owns **only** `/about`, `/privacy`, `/terms`, and the shared
`site.css` / `og-default.png`. It does **not** own `/`, `/give`, `/mine`, or
`/item/*` — those routes belong to the Expo app in `apps/web`. Do not add
pages here that shadow an app route.

## Preview locally

```
node apps/site/serve.mjs         # http://localhost:4321
node apps/site/serve.mjs 5000    # custom port
```

The server maps `/fonts/*` to `apps/site/.preview-fonts/` (gitignored local
copies of the six fonts the app serves in production) and everything else
to `apps/site/public/`. In production, fonts are served by `apps/web` at
`/fonts/Fraunces-VF.ttf`, `/fonts/Fraunces-Italic-VF.ttf`,
`/fonts/CourierPrime-Regular.ttf`, `/fonts/CourierPrime-Bold.ttf`,
`/fonts/CourierPrime-Italic.ttf`, `/fonts/CourierPrime-BoldItalic.ttf` —
`site.css` references those paths directly and never bundles its own font
files.

`.preview-fonts/` holds symlinks straight into `apps/web/public/fonts/`
(the same files, one copy on disk) — see that directory if the symlinks
ever go stale.

## How this ships

`apps/site/public/**` is copied verbatim into the Expo web export directory
by `apps/web`'s `scripts/copy-site.mjs` (added by that app), so the same
Cloudflare Worker serves both the app and this static site from one origin.
Because of that, all links here are root-relative (`/`, `/give`, `/privacy`,
etc.) rather than pointing at a separate host.

## OG image

`public/og-default.png` is generated from `og/og-default.svg`. Regenerate
with whatever SVG-to-PNG tool is available (see the source SVG's header
comment for the exact command used).
