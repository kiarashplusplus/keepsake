# QA screenshots

Viewport screenshots taken from the real local stack (`pnpm --filter @keepsake/web e2e`
against `wrangler dev`), committed so a pull request can show the change rather than
describe it.

Two rules, both learned the hard way elsewhere:

- **Never `captureBeyondViewport`.** A full-page capture of a page nobody could scroll
  looked perfect for a week. These are plain viewport shots at a phone size.
- **Commit the file; don't link a URL.** This repository is private, so GitHub's image
  proxy cannot fetch an external image and renders a broken thumbnail. A committed file
  referenced by path (or by blob SHA) is the only thing that shows up in a PR body.

Keep this directory small — a screenshot here is evidence for one change, not an archive.
Delete one once the change it argued for has shipped and been looked at.

**`baseline/` is the other kind of screenshot** and does not follow that rule: it is the
standing set — one frame of every screen, in both viewports, refreshed by
`pnpm --filter @keepsake/web e2e:ux` whenever a screen changes rather than deleted when a
change ships. See [baseline/README.md](baseline/README.md). Loose files here are still the
right thing for arguing one point in one pull request.

**Emptied 2026-09-07**, applying that rule for the first time. The seven files that were here
argued for #108, #133, #134, #135 and #136 — all five closed, all five shipped to `main`. They are
in git history, not gone:

```sh
git log --diff-filter=D --oneline -- docs/qa/    # the commit that removed them
git checkout <that-sha>^ -- docs/qa/<file>.png   # bring one back
```

If you restore one because the change it argued for turns out not to be finished, say so in the
issue too — a screenshot reappearing with no explanation is worse than one that never left.
