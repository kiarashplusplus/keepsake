/**
 * The parts of the photo pipeline that only a real browser can prove.
 *
 * `test/lib/images/prepareUpload.test.ts` stubs `createImageBitmap` and the
 * canvas, so it can pin the orchestration (how many decodes, what is refused
 * before an encode) but not the rasteriser itself. These two specs run the
 * shipped code against a real decode: one proves a shape is refused *without*
 * an upload, the other proves a failed upload can be recovered from.
 */
import { test, expect, onScreen } from "./support/fixtures";
import type { Page } from "@playwright/test";
import { makePng } from "./support/png";

async function pickPhoto(page: Page, buffer: Buffer, name = "photo.png"): Promise<void> {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await onScreen(page, "Add photos").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name, mimeType: "image/png", buffer });
}

test("a long thin photo is refused without spending an upload", async ({ page }) => {
  // 4000x60 clears the old source-only short-edge check (60 < 320 would have
  // caught this one, so make the short edge legal at source and let the *fit*
  // be what destroys it): 4000x400 fits to 2048x205, still under the floor.
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/photos") && request.method() === "PUT") uploads.push(request.url());
  });

  await page.goto("/give");
  await pickPhoto(page, makePng(4000, 400), "strip.png");

  await expect(page.getByText(/too long and thin/i)).toBeVisible();
  // The load-bearing half: refusing after uploading would have already spent
  // the thing the refusal exists to avoid.
  expect(uploads).toHaveLength(0);
  // And the flow must not be left in a state that blocks the giver.
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("a failed upload can be retried without picking the photo again", async ({ page }) => {
  let failNext = true;
  await page.route("**/api/photos", async (route) => {
    if (route.request().method() === "PUT" && failNext) {
      failNext = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false,"error":{"code":"unavailable","message":"nope"}}' });
      return;
    }
    await route.fallback();
  });

  await page.goto("/give");
  await pickPhoto(page, makePng(640, 800));

  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();

  await retry.click();

  // The tile recovers to a real uploaded photo — cover badge is the signal
  // the give flow itself uses.
  await expect(page.getByText("Cover", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
});
