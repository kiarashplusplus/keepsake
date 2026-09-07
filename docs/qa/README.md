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
