/**
 * Estate bulk upload — the first real-browser pass over `/bulk`. Everything
 * here was, until this spec, only ever driven by vitest and by hand against
 * `wrangler dev` (see PR #263's "What is still unverified"). This walks the
 * actual screens: land on the batch list, start a batch (self-serve now
 * that the admission code is gone — no operator step to stand in for),
 * add real photos, exercise grouping (merge into one item, split one
 * out per photo, and reassign a photo from one item to another), fill in
 * enough for two items to become "ready", submit, and watch the operation
 * finish. It also checks My Keepsakes' "Give several items" entry and its
 * private draft-batches section.
 *
 * `BULK_UPLOAD` has to be `"1"` for any of `/api/bulk/*` to answer with
 * anything but 404 — see `playwright.config.ts`'s `WEB_SERVER_COMMAND` for
 * where that's set for this suite.
 */
import type { Page } from "@playwright/test";
import { test, expect, onScreen } from "./support/fixtures";
import { mintOwnerToken, uniqueTitle } from "./support/api";
import { makePng } from "./support/png";

/**
 * Every grouping action here dispatches to the local reducer synchronously
 * (`applyLocalPlan`, before any `await` — see `useBulkWorkspace.ts`'s
 * `commitGroupingPlan`) and *then* pushes the changed item(s) to the server
 * in the background. That's enough for the DOM to update immediately, which
 * is all most assertions below need — but two grouping actions on the same
 * item close enough together would race the same `expected_revision`
 * against the server, since the second click's read of `item.revision`
 * could still be the pre-first-write value. This waits for the actual
 * `PUT .../items/:clientItemId` round trip so the two reassignment clicks
 * below (which touch item 1 then item 2, one after the other, with no
 * visible signal like the mocked title autofill to wait on instead) can't
 * race their own follow-up writes.
 */
function waitForItemPut(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (res) => res.request().method() === "PUT" && /\/api\/bulk\/batches\/[^/]+\/items\/[^/]+$/.test(new URL(res.url()).pathname),
  );
}

// Kept serial: these two are the heaviest writers in the suite (real photo
// uploads, a submission that runs the whole moderation pipeline) against the
// one local `wrangler dev`/D1 the whole suite shares, and nothing either
// test does needs them concurrent. The original reason — each shelling out
// to `wrangler d1 execute` to mint an admission grant — is gone with the
// admission code.
test.describe.configure({ mode: "serial" });

test("a giver prepares an estate batch across photos, review and submit", async ({ page, context, isMobile }) => {
  const ownerToken = mintOwnerToken();

  // Seeded the same way `fixtures.ts`'s `seedOwnerToken` does for the give
  // flow: land on this device as an existing owner rather than walking a
  // separate onboarding path this feature doesn't have.
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ["keepsake.ownerToken.v1", ownerToken],
  );

  const batchName = uniqueTitle("Mum's house");

  // --- Batch list, empty -----------------------------------------------
  await page.goto("/bulk");
  await expect(page.getByText("Give several items")).toBeVisible();
  await onScreen(page, "Start a new batch").click();

  // --- Start a batch -----------------------------------------------------
  await page.waitForURL(/\/bulk\/new$/);
  await page.getByLabel("Batch name").fill(batchName);
  await page.getByLabel("Postcode").fill("02144");
  // Required, like the give flow's own email step: a batch is dozens of
  // listings behind one device token, and `POST /batches/:id/submit` refuses
  // one whose owner has no way to be told that somebody asked.
  await page.getByLabel("Email").fill(`giver.${Math.random().toString(36).slice(2, 8)}@keepsake.ing`);
  await expect(page.getByText("Somerville, MA")).toBeVisible();
  await onScreen(page, "Start this batch").click();

  await page.waitForURL(/\/bulk\/[^/]+\/photos$/);

  // --- Photos: add three, wait for all three to finish uploading ---------
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByLabel("Add photos").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles([
    { name: "keepsake-a.png", mimeType: "image/png", buffer: makePng(640, 800, 1) },
    { name: "keepsake-b.png", mimeType: "image/png", buffer: makePng(640, 800, 2) },
    { name: "keepsake-c.png", mimeType: "image/png", buffer: makePng(640, 800, 3) },
  ]);

  // No per-tile "done" badge on this screen (unlike the give flow's "Cover"
  // badge) — the overlay text is the only visible signal, so wait for every
  // tile's "uploading…"/"queued…" overlay to clear.
  await expect(page.getByText(/uploading…|queued…/)).toHaveCount(0, { timeout: 30_000 });

  const trayCheckboxes = page.getByRole("checkbox", { name: "Select this photo" });
  await expect(trayCheckboxes).toHaveCount(3);

  // --- Grouping action 1 (merge): two photos into one item ----------------
  await trayCheckboxes.nth(0).click();
  await trayCheckboxes.nth(1).click();
  await page.getByRole("button", { name: /^Group as one item/ }).click();

  await expect(page.getByText("Grouped so far")).toBeVisible();
  // `listItems`/`itemOrder` (`batchStore.ts`) append in creation order and
  // `photos.tsx` renders `items.map(...)` straight over that array, so DOM
  // order tracks creation order — every subsequent scoping below relies on
  // that rather than on text content, since the mocked suggestion below
  // gives every item the *same* title and would make text-based scoping
  // ambiguous.
  const splitButtons = page.getByRole("button", { name: "Split" });
  await expect(splitButtons).toHaveCount(1);
  // Waits out both the grouping PUT and the automatic suggestion round trip
  // (`requestSuggestionInternal` fires once the plan commits, per
  // `useBulkWorkspace.ts`) — this item's title becomes the card heading
  // right here on Photos (`photos.tsx`'s `ItemGroupRow` falls back to a
  // photo count only while `fields.title` is unset), so waiting for it also
  // proves the suggestion actually reached the server, not just the client.
  await expect(page.getByText("Blue ceramic mug")).toHaveCount(1, { timeout: 15_000 });

  // --- Grouping action 2 (split, one-per-photo): the third, still
  //     unassigned photo becomes its own item ------------------------------
  await expect(trayCheckboxes).toHaveCount(1);
  await trayCheckboxes.nth(0).click();
  await page.getByRole("button", { name: /^One item per photo/ }).click();
  await expect(splitButtons).toHaveCount(2);
  await expect(trayCheckboxes).toHaveCount(0);
  await expect(page.getByText("Blue ceramic mug")).toHaveCount(2, { timeout: 15_000 });

  // --- Grouping action 3 (reassign): move a photo from item 1 to item 2 ---
  // `GroupThumb` renders "Remove from this item" unconditionally — cover or
  // not (only "Make this the cover" is cover-gated) — so item 1 (2 photos)
  // contributes 2 and item 2 (1 photo) contributes 1, in DOM/card order:
  // [item1-cover(A), item1-non-cover(B), item2-cover(C)]. `.nth(1)` is B.
  const removeButtons = page.getByLabel("Remove from this item");
  await expect(removeButtons).toHaveCount(3);
  const removePut = waitForItemPut(page);
  await removeButtons.nth(1).click();
  await removePut;
  await expect(trayCheckboxes).toHaveCount(1);
  await trayCheckboxes.nth(0).click();
  // Both cards now offer "Add 1 selected photo here" (tray selection is
  // batch-wide state, not per-card) — `.nth(1)` is item 2, by DOM order.
  const addSelectedHere = page.getByRole("button", { name: /^Add 1 selected photo here/ });
  await expect(addSelectedHere).toHaveCount(2);
  const addPut = waitForItemPut(page);
  await addSelectedHere.nth(1).click();
  await addPut;
  await expect(trayCheckboxes).toHaveCount(0);
  await expect(addSelectedHere).toHaveCount(0);

  // Item 1 is back down to its own one photo; item 2 now holds two.
  await expect(splitButtons).toHaveCount(2);

  // --- Review: give each item a story (title/category came from the mocked
  //     suggestion, verified here since Photos never shows a title field)
  //     and save ------------------------------------------------------------
  await page.getByRole("link", { name: "Review" }).click();
  await page.waitForURL(/\/bulk\/[^/]+\/review$/);

  const stories = [
    "My grandfather threw this on a kick wheel the winter he retired, and it held his coffee every morning after.",
    "A second keepsake from the same house — my grandmother kept these on the mantel for thirty years.",
  ];

  // Suggestion autofill (MOCK_AI, the same mechanism `give.spec.ts` asserts)
  // fires once each item's cover photo has actually finished uploading —
  // waiting for it below is what would catch grouping having raced ahead of
  // the upload queue. `MOCK_SUGGESTION` is a fixed constant (`suggest.ts`),
  // so both items get the same title.
  if (isMobile) {
    // Below `review.tsx`'s `NARROW_BREAKPOINT` (640px) it shows one expanded
    // item card at a time with Prev/Next, not a compact list — a deliberate
    // design difference (see that file's header), not something to route
    // around by only testing the desktop project.
    for (let i = 0; i < 2; i += 1) {
      await expect(page.getByLabel("Title")).toHaveValue("Blue ceramic mug", { timeout: 15_000 });
      await page.getByLabel("Story").fill(stories[i] as string);
      await page.getByRole("button", { name: "Save now" }).click();
      await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 15_000 });
      if (i === 0) await page.getByRole("button", { name: "Next →" }).click();
    }
  } else {
    const titleInputs = page.getByLabel("Title");
    await expect(titleInputs).toHaveCount(2);
    await expect(titleInputs.nth(0)).toHaveValue("Blue ceramic mug", { timeout: 15_000 });
    await expect(titleInputs.nth(1)).toHaveValue("Blue ceramic mug", { timeout: 15_000 });

    const storyInputs = page.getByLabel("Story");
    await expect(storyInputs).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) {
      await storyInputs.nth(i).fill(stories[i] as string);
    }
    const saveButtons = page.getByRole("button", { name: "Save now" });
    for (let i = 0; i < 2; i += 1) {
      await saveButtons.nth(i).click();
    }

    await expect(page.getByText("Ready", { exact: true })).toHaveCount(2, { timeout: 15_000 });
  }

  // --- Submit --------------------------------------------------------------
  await page.getByRole("link", { name: "Submit" }).click();
  await page.waitForURL(/\/bulk\/[^/]+\/submit$/);

  // RN Text wraps multi-expression children in nested spans, so a
  // substring match here hits both the outer and an inner node (strict-mode
  // violation) — the exact rendered string avoids that.
  await expect(page.getByText("2 ready · 0 need details · 0 upload failures", { exact: true })).toBeVisible();
  await page.getByLabel("Date of birth").fill("1990-01-01");
  await page.getByRole("button", { name: /^Submit 2 items/ }).click();

  // `POST /submit` fires `runBulkOperation` eagerly (see `routes/bulk.ts`'s
  // own comment on why), so under `MOCK_AI` this should reach "done" well
  // within the screen's own 3s poll interval, not require the 3-minute cron.
  await expect(page.getByText(/^Submission done/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/2 succeeded, 0 failed of 2/)).toBeVisible();

  // --- My Keepsakes: the "Give several items" entry and (this batch is
  //     fully submitted, so no draft section is expected for it — a second,
  //     untouched batch proves the draft section separately) --------------
  await page.goto("/mine");
  // `<Link asChild><Button .../></Link>` renders `Button`'s own Pressable
  // (accessibilityRole "button"), not an anchor — the `Link` only supplies
  // navigation behavior, not the accessible role.
  await expect(page.getByRole("button", { name: "Give several items" }).first()).toBeVisible();
});

test("My Keepsakes shows a private draft-batches section for an unsubmitted batch", async ({ page, context }) => {
  const ownerToken = mintOwnerToken();
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    ["keepsake.ownerToken.v1", ownerToken],
  );

  const batchName = uniqueTitle("Dad's garage");

  await page.goto("/bulk/new");
  await page.getByLabel("Batch name").fill(batchName);
  await page.getByLabel("Postcode").fill("02144");
  // Required, like the give flow's own email step: a batch is dozens of
  // listings behind one device token, and `POST /batches/:id/submit` refuses
  // one whose owner has no way to be told that somebody asked.
  await page.getByLabel("Email").fill(`giver.${Math.random().toString(36).slice(2, 8)}@keepsake.ing`);
  await expect(page.getByText("Somerville, MA")).toBeVisible();
  await onScreen(page, "Start this batch").click();
  await page.waitForURL(/\/bulk\/[^/]+\/photos$/);

  // Never submitted — this batch stays a draft, which is exactly what
  // My Keepsakes' private section is scoped to.
  await page.goto("/mine");
  await expect(page.getByText("Estate batches")).toBeVisible();
  // `DraftBatchesSection` sets this as the `Pressable`'s `accessibilityLabel`
  // directly — `getByLabel` matches the underlying `aria-label` regardless
  // of which element `expo-router`'s `Link asChild` ends up attaching the
  // outer interactive role to (a "link" here; a "button" for the unrelated
  // "Give several items" control above — not worth depending on either).
  await expect(page.getByLabel(`Continue preparing ${batchName}`)).toBeVisible();

  // And it's reachable from the batch list too.
  await page.goto("/bulk");
  await expect(page.getByText(batchName)).toBeVisible();
  await expect(page.getByText("Preparing", { exact: true })).toBeVisible();
});
