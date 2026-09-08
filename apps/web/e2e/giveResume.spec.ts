/**
 * Leaving the give flow and coming back — the two ways it used to go wrong.
 *
 * "← Back" went to the feed from every step, so stepping back from the
 * story to fix a photo threw the giver out of the flow; and the draft that
 * greeted them on "Give" a moment later showed each photo as a blurhash
 * smear with nothing to say whether that was their upload or a stuck one,
 * and no way to clear it short of trashing tiles one by one.
 */
import { test, expect, onScreen } from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { makePng } from "./support/png";

async function pickPhoto(page: Page, buffer: Buffer, name = "photo.png"): Promise<void> {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await onScreen(page, "Add photos").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name, mimeType: "image/png", buffer });
}

/**
 * The text `label` on the screen the visitor is looking at — `onScreen` for
 * copy rather than a control. The give flow's nested stack keeps earlier
 * steps mounted (hidden) under the current one, so a string can exist more
 * than once; and until the Give links became `dangerouslySingular`, "← Back"
 * to the feed left the whole give stack mounted underneath and "Give"
 * pushed a second one on top of it — the hidden copy still holding this
 * session's blob previews, the visible one the draft read back from storage.
 * The "one give flow" test below is what now guarantees that cannot recur;
 * this helper keeps the rest of the assertions honest either way.
 */
function visibleText(page: Page, text: string | RegExp): Locator {
  return page
    .getByText(text, typeof text === "string" ? { exact: true } : {})
    .filter({ visible: true });
}

/** The pixel width the browser decoded for the *visible* tile's image —
 * `0` for a placeholder-only tile, a 404 or anything that never became an
 * image. Visible only: the hidden earlier screen's tile still has its blob
 * URL, and counting it would prove nothing about the resumed one. */
async function decodedTileWidth(page: Page): Promise<number> {
  return page
    .getByAltText("Keepsake photo 1")
    .filter({ visible: true })
    .evaluateAll((nodes) =>
      Math.max(0, ...nodes.map((node) => (node as HTMLImageElement).naturalWidth ?? 0)),
    );
}

test("back from the story step returns to the photos step, with the tile intact", async ({
  page,
}) => {
  await page.goto("/give");
  await pickPhoto(page, makePng(640, 800));
  await expect(page.getByText("Cover", { exact: true })).toBeVisible({ timeout: 30_000 });
  await onScreen(page, "Continue").click();
  await expect(page.getByText("Tell its story.")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Step 2 of 5" })).toBeVisible();

  await page.getByLabel("Back to photos").click();

  await expect(page.getByText("Show us the keepsake.")).toBeVisible();
  await expect(page).toHaveURL(/\/give\/?$/);
  await expect(page.getByRole("progressbar", { name: "Step 1 of 5" })).toBeVisible();
  // The photos screen was popped back to, not re-created: its tile, its
  // cover badge and its "Continue" are exactly as they were left.
  await expect(page.getByText("Cover", { exact: true })).toBeVisible();
  await expect(onScreen(page, "Continue")).toBeEnabled();
  // Same session, same in-memory preview — nothing was resumed from storage.
  await expect(page.getByText("Picked up where you left off.")).toHaveCount(0);
  // And only the first step's back leaves the flow.
  await expect(page.getByLabel("Back to the feed")).toBeVisible();
});

test("leaving for the feed and coming back returns to the one give flow", async ({ page }) => {
  await page.goto("/give");
  await pickPhoto(page, makePng(640, 800));
  await expect(page.getByText("Cover", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Back to the feed").click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/(\?.*)?$/);
  // The header's own "Give" — the way a giver actually comes back.
  await onScreen(page, "Give").or(onScreen(page, "Give something")).first().click();
  await expect(visibleText(page, "Show us the keepsake.")).toBeVisible();

  // One give flow, not two. The root stack keeps the flow the giver backed
  // out of mounted under the feed, and the header's "Give" used to push a
  // second one on top of it: two shells, two photos screens, and a hidden
  // upload nobody could see. `dangerouslySingular` on the Give links keeps
  // it to one — counted unfiltered, hidden copies included, because a hidden
  // duplicate is exactly the bug.
  await expect(page.getByText("Show us the keepsake.")).toHaveCount(1);
  await expect(page.getByLabel("Back to the feed")).toHaveCount(1);
  // And it is the same flow: the tile still holds this session's preview,
  // so nothing was read back from storage and nothing says it was.
  await expect(visibleText(page, "Cover")).toBeVisible();
  await expect(onScreen(page, "Continue")).toBeEnabled();
  await expect(visibleText(page, "Picked up where you left off.")).toHaveCount(0);
});

test("a draft read back from storage shows the real photo, says so, and can start over", async ({
  page,
}) => {
  await page.goto("/give");
  await pickPhoto(page, makePng(640, 800));
  await expect(page.getByText("Cover", { exact: true })).toBeVisible({ timeout: 30_000 });

  // A full load: what a phone does to a tab it put in the background, and
  // the one path where the blob previews are genuinely gone. This is the
  // screenshot the issue came with — a blurhash smear with nothing to say
  // whether it was the upload or a stuck one.
  await page.goto("/give");
  await expect(visibleText(page, "Show us the keepsake.")).toBeVisible();

  // The draft came back, and it says so.
  await expect(visibleText(page, "Picked up where you left off.")).toBeVisible();
  await expect(visibleText(page, "Cover")).toBeVisible();
  await expect(onScreen(page, "Continue")).toBeEnabled();
  // The load-bearing half: the tile shows the photo itself, fetched through
  // the owner-authed `/i/:id/thumb` route (the listing does not exist yet,
  // so the route answers only with the owner token) — not the blurhash
  // alone. Not `> 0`: the blurhash placeholder is itself an `<img>` with the
  // same alt, decoded to a 160px blob, and that bound passed with the thumb
  // rung deliberately removed. The client-side thumb of a 640x800 source is
  // 512x640, so 320 is a width only the real photo reaches.
  await expect.poll(() => decodedTileWidth(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(320);

  await onScreen(page, "Start over").click();

  await expect(visibleText(page, "Picked up where you left off.")).toHaveCount(0);
  await expect(visibleText(page, "Cover")).toHaveCount(0);
  await expect(page.getByAltText("Keepsake photo 1").filter({ visible: true })).toHaveCount(0);
  await expect(onScreen(page, "Continue")).toBeDisabled();
  await expect(visibleText(page, "5 left")).toBeVisible();
});

test("an upload cut short by leaving the flow comes back as a failed tile, not a stuck one", async ({
  page,
}) => {
  // Hold every upload open for the whole test, so the draft is persisted
  // with the tile still "uploading" and nothing can finish it in the
  // background before the giver comes back.
  const held: (() => void)[] = [];
  await page.route("**/api/photos", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await new Promise<void>((resolve) => held.push(resolve));
    await route.abort("aborted").catch(() => {});
  });

  await page.goto("/give");
  await pickPhoto(page, makePng(640, 800));
  await expect(page.getByText("uploading…")).toBeVisible();

  await page.getByLabel("Back to the feed").click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/(\?.*)?$/);
  // A full load, not the header's link: that is what a phone does to a tab
  // it put in the background, and it is the one path where the interrupted
  // request cannot land on a screen that is still mounted. `sessionStorage`
  // survives it; the upload does not.
  await page.goto("/give");

  await expect(visibleText(page, "Picked up where you left off.")).toBeVisible();
  await expect(visibleText(page, "uploading…")).toHaveCount(0);
  await expect(visibleText(page, /didn't finish/)).toBeVisible();
  // Nothing to retry from (the source file died with the last page), so
  // the only offers are to remove the tile or to start over.
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(onScreen(page, "Continue")).toBeDisabled();

  for (const release of held) release();
  await page.unroute("**/api/photos");
});
