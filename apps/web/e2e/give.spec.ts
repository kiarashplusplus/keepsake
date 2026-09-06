/**
 * The whole give flow, from an empty photo tile to a listing a stranger can
 * find — the one spec that touches every layer at once: canvas resize and
 * blurhash in the browser, `PUT /api/photos` into R2, `POST /api/listings`,
 * the moderation pipeline running in `waitUntil()` (instant under
 * `MOCK_AI=1`), the review screen's poll, the feed, and the Worker's
 * HTMLRewriter OG injection on `/item/:id`.
 */
import { test, expect, onScreen } from "./support/fixtures";
import { uniqueTitle } from "./support/api";
import { makePng } from "./support/png";

const STORY =
  "My grandfather threw this on a kick wheel the winter he retired, and it held his morning coffee every day after. " +
  "I have no shelf left for it, and it should be used rather than boxed.";

test("a giver walks the five steps and the keepsake goes live", async ({ page, request }) => {
  const title = uniqueTitle("Hand-thrown mug");

  await page.goto("/give");

  // --- 1. Photos -----------------------------------------------------------
  // `src/lib/images/pickImages.web.ts` builds a hidden <input type="file">,
  // clicks it, and tears it down again, so there is no stable input to target
  // — the file chooser event is the seam.
  const fileChooserPromise = page.waitForEvent("filechooser");
  await onScreen(page, "Add photos").click();
  const fileChooser = await fileChooserPromise;
  // A real, decodable PNG: the client decodes it with `createImageBitmap` and
  // rejects anything under 320px on the short edge before uploading.
  await fileChooser.setFiles({ name: "keepsake.png", mimeType: "image/png", buffer: makePng(640, 800) });

  // The "Cover" badge only renders once the tile's status is `done`, i.e.
  // once the resize + `PUT /api/photos` round trip has actually landed.
  await expect(page.getByText("Cover", { exact: true })).toBeVisible({ timeout: 30_000 });
  await onScreen(page, "Continue").click();

  // --- 2. Story ------------------------------------------------------------
  await expect(page.getByText("Tell its story.")).toBeVisible();
  await page.getByLabel("Story").fill(STORY);
  await onScreen(page, "Continue").click();

  // --- 3. Details ----------------------------------------------------------
  await expect(page.getByText("A few details.")).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Home & kitchen", { exact: true }).click();
  await page.getByLabel("Postcode").fill("02144");
  // The live `GET /api/geo/lookup` behind the postcode field.
  await expect(page.getByText("Somerville, MA")).toBeVisible();
  await onScreen(page, "Continue").click();

  // --- 4. Email (skipped) --------------------------------------------------
  await expect(page.getByText("Want a way back?")).toBeVisible();
  await onScreen(page, "Skip").click();

  // --- 5. Review and submit ------------------------------------------------
  await expect(page.getByText("Take a last look.")).toBeVisible();
  await onScreen(page, "Give it").click();

  // The breathing-stamp reviewing state, then the settled one. The screen
  // polls `GET /api/me/listings/:id` every 3s, so this needs more than the
  // default assertion timeout even though the pipeline itself is instant.
  await expect(page.getByText("It's live.")).toBeVisible({ timeout: 45_000 });

  // "See it" is a full navigation to the canonical item URL, which is also
  // how this test learns the id the API minted.
  await onScreen(page, "See it").click();
  await page.waitForURL(/\/item\/[0-9A-Za-z]+$/);
  const listingId = page.url().split("/item/")[1] as string;
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  // It is on the public feed, for anyone.
  await page.goto("/");
  await expect(page.getByLabel(title, { exact: true })).toBeVisible();

  // And the shell a link unfurler sees carries the listing's own title,
  // injected server-side by `apps/api/src/routes/item.ts` — no JS involved.
  const shell = await request.get(`/item/${listingId}`);
  expect(shell.status()).toBe(200);
  const html = await shell.text();
  expect(html).toContain(`<title>${title} — Keepsake</title>`);
  expect(html).toContain(`<meta property="og:title" content="${title}">`);
});
