/**
 * The whole give flow, from an empty photo tile to a listing a stranger can
 * find — the one spec that touches every layer at once: canvas resize and
 * blurhash in the browser, `PUT /api/photos` into R2, `POST /api/listings`,
 * the moderation pipeline running in `waitUntil()` (instant under
 * `MOCK_AI=1`), the review screen's poll, the feed, and the Worker's
 * HTMLRewriter OG injection on `/item/:id`.
 */
import { test, expect, onScreen } from "./support/fixtures";
import { freshClientIp, uniqueTitle } from "./support/api";
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
  await fileChooser.setFiles({
    name: "keepsake.png",
    mimeType: "image/png",
    buffer: makePng(640, 800),
  });

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
  // Autofill: `POST /api/photos/:id/suggest` (instant under `MOCK_AI=1`,
  // see `apps/api/src/suggest/suggest.ts`'s `MOCK_SUGGESTION`) is fired by
  // `<SuggestionFetcher>` the moment the cover photo finishes uploading in
  // step 1, and the reducer pre-fills the title from it — this is the
  // assertion that would have caught the flow never wiring the endpoint up
  // at all.
  await expect(page.getByLabel("Title")).toHaveValue("Blue ceramic mug");
  await expect(page.getByText("Filled in from your photo. Change anything.")).toBeVisible();
  await page.getByLabel("Title").fill(title);
  // Issue #35: no category picker here anymore — `draft.category` follows
  // the mocked suggestion's category ("home_kitchen") automatically.
  await page.getByLabel("Postcode").fill("02144");
  // The live `GET /api/geo/lookup` behind the postcode field.
  await expect(page.getByText("Somerville, MA")).toBeVisible();
  await onScreen(page, "Continue").click();

  // --- 4. Email ------------------------------------------------------------
  // No longer skippable: a listing with no address behind it is one nobody
  // can ever be told about (see `app/give/email.tsx`), and `POST
  // /api/listings` refuses one.
  await expect(page.getByText("Where should we reach you?")).toBeVisible();
  await onScreen(page, "Continue").click();
  await expect(page.getByText("We need an email to tell you when someone asks.")).toBeVisible();
  await page.getByLabel("Email").fill("giver@keepsake.ing");
  await onScreen(page, "Continue").click();

  // --- 5. Review and submit ------------------------------------------------
  await expect(page.getByText("Take a last look.")).toBeVisible();
  // The gap that let the cover photo go missing from this step entirely:
  // the print card must actually render an image, not just a photo count.
  await expect(page.getByAltText("Cover photo")).toBeVisible();
  // Issue #64: a neutral date-of-birth prompt, not an "I'm 18 or older"
  // checkbox.
  await page.getByLabel("Date of birth").fill("1990-01-01");
  await onScreen(page, "Give it").click();

  // The breathing-stamp reviewing state, then the settled one. The screen
  // polls `GET /api/me/listings/:id` every 3s, so this needs more than the
  // default assertion timeout even though the pipeline itself is instant.
  await expect(page.getByText("It's live.")).toBeVisible({ timeout: 45_000 });

  // The giver sees the card their friends will get. `getByAltText`, not
  // `getByLabel`: `expo-image` renders an <img alt="…"> on web, so
  // `accessibilityLabel` lands on `alt` and a label locator finds nothing.
  const cardPreview = page.getByAltText("Preview of the link card your friends will see");
  await expect(cardPreview).toBeVisible();
  await expect(page.getByText("This is what your friends will see.")).toBeVisible();

  // And it is the real card, not a broken image: `naturalWidth` is only
  // non-zero once the browser has actually decoded the response, and 1200 is
  // the card's own width. A 404 or an HTML error page would be 0.
  await expect
    .poll(async () => cardPreview.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBe(1200);

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
  // The `request` fixture is its own `APIRequestContext`, separate from the
  // page's browser context, so it doesn't inherit the `CF-Connecting-IP` the
  // `context` fixture set — without an explicit one here this call would
  // land on the shared "unknown" bucket `GET /item/:id`'s `burst("RL_READ")`
  // falls back to (`clientIPFrom`), rather than this test's own address
  // (`freshClientIp()` in `./support/api`'s own doc comment explains why the
  // whole suite would otherwise rate-limit itself).
  const shell = await request.get(`/item/${listingId}`, {
    headers: { "CF-Connecting-IP": freshClientIp() },
  });
  expect(shell.status()).toBe(200);
  const html = await shell.text();
  expect(html).toContain(`<title>${title} — Keepsake</title>`);
  expect(html).toContain(`<meta property="og:title" content="${title}">`);

  // And the card that shell advertises really renders — against the real
  // Worker, the real R2 object, and the photo this test actually uploaded.
  // Everything below is asserted in unit tests too, on synthetic bytes; what
  // this adds is the one thing a fixture cannot stand in for, the SIZE of a
  // card built from a real image.
  const cardUrl = /<meta property="og:image" content="([^"]+)">/.exec(html)?.[1];
  expect(cardUrl).toBeTruthy();

  const card = await request.get(new URL(cardUrl as string).pathname + new URL(cardUrl as string).search, {
    headers: { "CF-Connecting-IP": freshClientIp() },
  });
  expect(card.status()).toBe(200);
  expect(card.headers()["content-type"]).toBe("image/jpeg");

  // The WhatsApp budget. A link preview image much past ~300 KB stops being
  // rendered by some clients, and this is the assertion that holds the line
  // as the card's design changes — the fibre texture and the photo window
  // are both things a later change could make far more expensive. Measured
  // headroom at the time of writing was roughly 3x.
  const bytes = (await card.body()).length;
  expect(bytes).toBeGreaterThan(1000); // not an empty or error body
  expect(bytes).toBeLessThan(300_000);
});
