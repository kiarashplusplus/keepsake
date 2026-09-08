/**
 * The UX baseline: one viewport screenshot of every screen this product has,
 * in the states worth looking at, written to `docs/qa/baseline/<project>/`.
 *
 * This is a *capture* run, not a gate — nothing here compares pixels (see
 * `docs/qa/baseline/README.md` for why that would be a check that fails for
 * the wrong reasons on a different machine). What it is for is the review
 * that no assertion can do: is this screen crowded, is the story legible at
 * 390px, does the dark table still look like a table. The reviewer is a
 * person (or a model) looking at the files; the suite's job is to produce
 * them from the real stack, deterministically, in a couple of minutes.
 *
 * It does not run under `pnpm --filter @keepsake/web e2e`. The two projects
 * that own these captures only exist when `UX_SHOTS` is set — `pnpm --filter
 * @keepsake/web e2e:ux` sets it — so an ordinary suite run can never rewrite
 * 40-odd committed PNGs as a side effect, and a capture run always gets a
 * freshly wiped database rather than one the functional specs have been
 * posting into (`playwright.config.ts` turns `reuseExistingServer` off for
 * exactly that reason).
 *
 * **Every capture is preceded by an assertion that the screen is actually
 * there.** A screenshot spec with nothing in front of it passes just as
 * happily against a blank page, which is the failure mode this repository
 * keeps re-learning; `expect(...).toBeVisible()` before each `shot()` is what
 * makes a broken screen fail the run instead of quietly becoming the new
 * baseline.
 *
 * Turnstile is not involved at any point, in either half: the Worker runs
 * with no `TURNSTILE_SECRET` (`e2e/support/global-setup.mjs`) and the export
 * carries no site key, so the widget reports `unconfigured` and every submit
 * button here is reachable. That is the same arrangement the rest of the
 * suite runs under — see `playwright.config.ts`'s header.
 */
import { test, expect, onScreen, openFreshContext, seedOwnerToken } from "./support/fixtures";
import { ADMIN_TOKEN, freshClientIp, ownerHeaders, OWNER_TOKEN_STORAGE_KEY } from "./support/api";
import { BASE_URL } from "./support/constants";
import { seedConsent } from "./support/consent";
import { seedVisited } from "./support/visited";
import { DEMO_PHOTOS, readDemoPhoto } from "./support/demoPhotos";
import {
  DEMO_HIDDEN_LISTING,
  DEMO_LISTINGS,
  DEMO_OWNER_TOKEN,
  DEMO_REQUESTS,
  ensureDemoCatalog,
} from "./support/demoCatalog";
import { ensureDemoBulkBatch } from "./support/demoBulkBatch";
import { seedTheme, shot } from "./support/shots";
import type { Browser, BrowserContext } from "@playwright/test";

/**
 * The keepsake the give-flow walkthrough types in — deliberately not one of
 * the six in `demoCatalog.ts`. It is created by the capture and deleted at
 * the end of the same test, so the feed both projects photograph is always
 * exactly the fixed catalogue; a distinct title is what makes a leftover
 * obvious if that cleanup ever stops working.
 */
const GIVEN_HERE = {
  title: "Pressed-glass butter dish",
  story:
    "It sat on my mother's table every Sunday of my childhood and has one chip on the lid from a Christmas I would rather not go into. I have no table it suits any more, and it should be used rather than wrapped in newspaper in my loft.",
};

/** The project whose captures include the dark set — one is enough evidence
 * that the palette holds, and a second full dark run doubles the committed
 * bytes for a second look at the same colours. */
const DARK_PROJECT = "ux-mobile";

/**
 * `browser.newContext()` ignores the project's `use`, so every context this
 * spec builds by hand has to restate the capture-wide `reducedMotion` from
 * `playwright.config.ts` — see the note there for why the baseline is taken
 * under it. Miss one and it is the only frame still catching a spring
 * mid-drop, which reads as a design change on the next refresh.
 */
const CAPTURE_CONTEXT = { reducedMotion: "reduce" } as const;

/** A context with nothing seeded at all, for the two screens that only exist
 * for someone who has never been here: the explainer and the consent banner.
 * `openFreshContext()` seeds both of those away, which is the right default
 * everywhere else in this suite. */
async function openUnseededContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": freshClientIp() },
    ...CAPTURE_CONTEXT,
  });
}

test.describe("ux baseline", () => {
  test("the way in: explainer, consent banner, feed", async ({
    page,
    browser,
    request,
  }, testInfo) => {
    await ensureDemoCatalog(request);

    // --- The first-time visitor's explainer ---------------------------------
    // `app/+html.tsx` redirects `/` to `/welcome` for a device with no owner
    // token and no visited flag, so this needs a context with neither.
    const firstVisit = await openUnseededContext(browser);
    // Consent is an independent variable from "has visited before": leave it
    // unseeded and the banner covers the bottom third of the explainer, which
    // is the one screen this frame exists to show. The banner gets its own
    // frame below.
    await seedConsent(firstVisit);
    const welcome = await firstVisit.newPage();
    await welcome.goto("/");
    await welcome.waitForURL(/\/welcome$/);
    await expect(welcome.getByText(/ready to let go of/)).toBeVisible();
    await shot(welcome, testInfo, "welcome");
    await firstVisit.close();

    // --- The consent banner, over the feed ----------------------------------
    const undecided = await openUnseededContext(browser);
    await seedVisited(undecided); // visited, but has never answered the banner
    const banner = await undecided.newPage();
    await banner.goto("/");
    await expect(banner.getByText("Your choice, before anything loads.")).toBeVisible();
    await shot(banner, testInfo, "consent-banner");
    await undecided.close();

    // --- The feed itself ----------------------------------------------------
    // Two frames, because at 390px they are genuinely two different screens:
    // what the table looks like when it opens (all invitation and controls,
    // no keepsakes yet) and what it looks like once the cards are on it. A
    // baseline that only had the first would keep saying the feed is fine.
    await page.goto("/");
    await expect(page.getByLabel("Search")).toBeVisible();
    const firstCard = page.getByLabel(DEMO_LISTINGS[5]!.title, { exact: true });
    await expect(firstCard).toBeVisible();
    await shot(page, testInfo, "feed");

    await firstCard.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "feed-cards");

    await page.getByLabel("Jewelry & watches", { exact: true }).click();
    await expect(page).toHaveURL(/[?&]category=jewelry_watches\b/);
    const brooch = page.getByLabel(DEMO_LISTINGS[1]!.title, { exact: true });
    await expect(brooch).toBeVisible();
    await brooch.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "feed-category");

    await page.goto("/");
    await page.getByLabel("Search").fill("zzzznothingmatchesthis");
    // Not /Nothing here yet/ any more: that was the empty-marketplace copy
    // this frame was filed against (#220). A search that matches nothing now
    // says so, and offers to clear itself.
    const nothingHere = page.getByText(/Nothing matches/);
    await expect(nothingHere).toBeVisible();
    // `toBeVisible()` is happy with a line the visitor would have to scroll to
    // reach — which is exactly the state this frame is supposed to show.
    await nothingHere.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "feed-search-empty");
  });

  test("an item page, and the two sheets it opens", async ({ page, request }, testInfo) => {
    const catalog = await ensureDemoCatalog(request);

    await page.goto(`/item/${catalog.ids.letters}`);
    await expect(page.getByText(DEMO_LISTINGS[2]!.title, { exact: true })).toBeVisible();
    await shot(page, testInfo, "item");

    await page.getByLabel("I'd love this").click();
    await expect(page.getByLabel("Note")).toBeVisible();
    await shot(page, testInfo, "item-request-sheet");

    // Filled in, because an empty form and a form mid-thought are different
    // design problems — this is the one the giver's first request comes from.
    await page.getByLabel("Note").fill(DEMO_REQUESTS[0]!.note);
    await page.getByLabel("Email", { exact: true }).fill(DEMO_REQUESTS[0]!.email);
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await shot(page, testInfo, "item-request-sheet-filled");

    await page.getByLabel("Send").click();
    // #188 replaced "Sent." with the confirm-by-email copy, and this line was
    // never updated — so the whole capture run has been failing here, and the
    // baseline unrefreshable, since that shipped. Matching a stable fragment
    // rather than the full paragraph so a comma does not do this again.
    await expect(page.getByText(/We've emailed you to check it was really you/)).toBeVisible();
    await shot(page, testInfo, "item-request-sent");

    await page.goto(`/item/${catalog.ids.records}`);
    await expect(page.getByText(DEMO_LISTINGS[4]!.title, { exact: true })).toBeVisible();
    await page.getByLabel("Report").click();
    await expect(page.getByRole("radio", { name: "Spam" })).toBeVisible();
    await shot(page, testInfo, "item-report-sheet");
  });

  test("the give flow, all five steps and the stamp at the end", async ({
    page,
    request,
  }, testInfo) => {
    // Longer than the suite default: this walks the whole wizard, uploads a
    // real photo, and then waits on the moderation pipeline, with a capture
    // at every step.
    test.setTimeout(240_000);

    await page.goto("/give");
    await expect(page.getByText("Show us the keepsake.")).toBeVisible();
    await shot(page, testInfo, "give-1-photos-empty");

    const fileChooserPromise = page.waitForEvent("filechooser");
    await onScreen(page, "Add photos").click();
    const fileChooser = await fileChooserPromise;
    // A real photograph, handed to the real picker: the browser decodes it,
    // checks the edge against `MIN_SOURCE_EDGE_PX` and resizes it exactly as
    // it would a giver's, so `give-1-photos-filled` and the review card show
    // what a giver actually sees rather than a gradient. No dimensions or
    // blurhash here — unlike `api.ts`, this path computes its own.
    await fileChooser.setFiles({
      name: "keepsake.jpg",
      mimeType: "image/jpeg",
      buffer: readDemoPhoto(DEMO_PHOTOS.butterdish),
    });
    await expect(page.getByText("Cover", { exact: true })).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, "give-1-photos-filled");
    await onScreen(page, "Continue").click();

    await expect(page.getByText("Tell its story.")).toBeVisible();
    await shot(page, testInfo, "give-2-story-empty");
    await page.getByLabel("Story").fill(GIVEN_HERE.story);
    await shot(page, testInfo, "give-2-story-filled");
    await onScreen(page, "Continue").click();

    // The autofilled title is the point of this screen: `MOCK_AI=1` makes
    // `POST /api/photos/:id/suggest` answer instantly, and the reducer
    // pre-fills from it — so the capture shows the suggestion banner a real
    // giver sees, not an empty form.
    await expect(page.getByText("A few details.")).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue("Blue ceramic mug");
    await shot(page, testInfo, "give-3-details-suggested");
    await page.getByLabel("Title").fill(GIVEN_HERE.title);
    await page.getByLabel("Postcode").fill("02144");
    await expect(page.getByText("Somerville, MA")).toBeVisible();
    await shot(page, testInfo, "give-3-details-filled");
    await onScreen(page, "Continue").click();

    await expect(page.getByText("Want a way back?")).toBeVisible();
    await shot(page, testInfo, "give-4-email");
    await onScreen(page, "Skip").click();

    await expect(page.getByText("Take a last look.")).toBeVisible();
    await expect(page.getByAltText("Cover photo")).toBeVisible();
    await shot(page, testInfo, "give-5-review");
    await page.getByLabel("Date of birth").fill("1990-01-01");
    // The frame above stops at the print card; the thing the giver has to
    // find — a date of birth and then "Give it" — is under it on a phone.
    const giveIt = onScreen(page, "Give it");
    await giveIt.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "give-5-review-submit");
    await giveIt.click();

    await expect(page.getByText("It's live.")).toBeVisible({ timeout: 45_000 });
    await shot(page, testInfo, "give-6-live");

    // Then take it back off the table.
    //
    // Both baseline projects run against one database, and this test is the
    // only one here that adds to it: left in place, the keepsake this run
    // gives would sit on the feed for every frame the *other* project takes
    // afterwards, and the two `feed` baselines would differ by a card for no
    // design reason at all. `DELETE /api/listings/:id` carries `ownerAuth()`
    // and no Turnstile (AGENTS.md's write-path bullet), so the device that
    // just gave it can withdraw it with the token in its own localStorage.
    const ownerToken = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      OWNER_TOKEN_STORAGE_KEY,
    );
    expect(ownerToken, "the give flow should have minted an owner token").toBeTruthy();
    const headers = ownerHeaders(ownerToken as string);
    const mine = await request.get("/api/me/listings", { headers });
    const body = (await mine.json()) as { data?: { id: string }[] };
    for (const listing of body.data ?? []) {
      const deleted = await request.delete(`/api/listings/${listing.id}`, { headers });
      expect(
        deleted.ok(),
        `cleaning up ${listing.id} so the next project sees the fixed table`,
      ).toBeTruthy();
    }
  });

  test("what the giver comes back to", async ({ page, context, request, browser }, testInfo) => {
    const catalog = await ensureDemoCatalog(request);

    // --- A device that has never given anything -----------------------------
    const strangerContext = await openFreshContext(browser, CAPTURE_CONTEXT);
    const stranger = await strangerContext.newPage();
    await stranger.goto("/mine");
    await expect(stranger.getByText(/given anything yet/)).toBeVisible();
    await shot(stranger, testInfo, "mine-empty");
    await strangerContext.close();

    // --- The demo giver's own six -------------------------------------------
    await seedOwnerToken(context, catalog.ownerToken);
    await page.goto("/mine");
    await expect(page.getByText(DEMO_LISTINGS[0]!.title, { exact: true }).first()).toBeVisible();
    await shot(page, testInfo, "mine");

    // The listing two strangers have asked for: the notes are on the page,
    // the addresses are masked until Choose. That masking is the screen's
    // whole design argument, so it is worth a frame of its own.
    //
    // One listing per project, because Choose is a one-way door and the two
    // projects share one database: whichever ran first would leave the second
    // looking at a chosen listing under a frame named `-requests`. Hence two
    // listings carrying the same pair of requests (`demoCatalog.ts`), one for
    // each. The visible consequence is that the project running second shows
    // the other's keepsake already chosen in its `mine` frame — that is the
    // shared table, not a flake.
    const requestedId = catalog.requestedIdFor(testInfo.project.name);
    await page.goto(`/mine/${requestedId}`);

    // The four frames below need a request the giver can actually see, and
    // since #188 there is no way for this harness to produce one: an ask is
    // held until the stranger clicks a link that only exists in an email, and
    // `request.spec.ts` is explicit that not being able to reach that token
    // is the point rather than a gap ("giving the product a way to hand a
    // confirmation token to a test" is the thing #188 exists to prevent).
    //
    // So this stops here rather than pretending. Skipping loudly, with the
    // frames above already written, keeps the rest of the baseline
    // refreshable — the alternative is a capture run that always fails, which
    // is what has been happening since #188 and is why every frame in this
    // directory was stale. `mine-detail-requests`, `-choose`, `-chosen` and
    // `mine-email` stay at whatever they last showed; see #240.
    const firstNote = page.getByText(DEMO_REQUESTS[0]!.note, { exact: true });
    test.skip(
      (await firstNote.count()) === 0,
      "no confirmed request to photograph: #188 holds an ask until an emailed link is clicked, which this harness cannot do — see #240",
    );

    await expect(firstNote).toBeVisible();
    await shot(page, testInfo, "mine-detail-requests");

    await page.getByLabel("Choose").first().click();
    await expect(page.getByLabel("Handoff note")).toBeVisible();
    await shot(page, testInfo, "mine-detail-choose");
    await page
      .getByLabel("Handoff note")
      .fill("I'm home most evenings — knock any time after six.");
    await page.getByLabel("Confirm").click();
    await expect(page.getByText("Chosen", { exact: true })).toBeVisible();
    await shot(page, testInfo, "mine-detail-chosen");

    await page.goto("/mine/email");
    await expect(page.getByText("Your email")).toBeVisible();
    await shot(page, testInfo, "mine-email");
  });

  test("the estate bulk workspace", async ({ page, context, request }, testInfo) => {
    // New with the bulk-upload pilot (PR #263) — `ensureDemoBulkBatch` mints
    // its own admission grant for `DEMO_OWNER_TOKEN` (see that module's
    // header on why there's no self-serve path onto `/bulk` to walk instead)
    // and seeds one batch: two photos grouped into a filled-in, ready item,
    // and a third left unassigned in the tray, so Photos shows both halves
    // of "add and group" at once rather than an empty or an all-grouped tray.
    const batch = await ensureDemoBulkBatch(request);
    await seedOwnerToken(context, DEMO_OWNER_TOKEN);

    await page.goto("/bulk");
    await expect(page.getByText("Give several items")).toBeVisible();
    await expect(page.getByText("UX baseline — estate batch", { exact: true })).toBeVisible();
    await shot(page, testInfo, "bulk-batches");

    // Started, not submitted: a filled admission code and postcode, one tap
    // from creating a *second* batch — which this frame deliberately never
    // does, so the fixture stays idempotent across runs.
    await page.goto("/bulk/new");
    await expect(page.getByText("Start clearing a house.")).toBeVisible();
    await page.getByLabel("Batch name").fill("Dad's workshop — October");
    await page.getByLabel("Postcode").fill("02144");
    await expect(page.getByText("Somerville, MA")).toBeVisible();
    // Filled, not left to the placeholder: the placeholder text reads as a
    // real example household story at a glance, which made an earlier
    // baseline look like it had a stuck "0/2000" counter — it was
    // correctly counting the actually-empty field.
    await page.getByLabel("Shared household story (optional)").fill("Everything here belonged to my grandmother, who lived in this house for sixty years.");
    await page.getByLabel("Admission code").fill(batch.grantId);
    await shot(page, testInfo, "bulk-new");

    await page.goto(`/bulk/${batch.clientBatchKey}/photos`);
    await expect(page.getByText("Add and group photos.")).toBeVisible();
    await expect(page.getByText("Pressed tin ceiling tile")).toBeVisible();
    await shot(page, testInfo, "bulk-photos");

    await page.goto(`/bulk/${batch.clientBatchKey}/review`);
    // Unlike Photos' card heading, Review shows the title inside a `Title`
    // `TextInput` — an input's value is not text content, so `getByText`
    // never matches it here.
    await expect(page.getByLabel("Title")).toHaveValue("Pressed tin ceiling tile");
    await shot(page, testInfo, "bulk-review");

    await page.goto(`/bulk/${batch.clientBatchKey}/submit`);
    await expect(page.getByText("Publish what's ready.")).toBeVisible();
    await expect(page.getByText(/1 ready/)).toBeVisible();
    await shot(page, testInfo, "bulk-submit");

    // My Keepsakes' private draft-batches section — a separate frame from
    // the plain `mine` one above rather than folded into it: that frame's
    // test runs earlier in this file, before this batch exists, and
    // changing what it shows retroactively would be a second, unrelated
    // frame changing for anyone diffing this one's baseline.
    await page.goto("/mine");
    await expect(page.getByText("Estate batches")).toBeVisible();
    await shot(page, testInfo, "mine-bulk-drafts");
  });

  test("the screens on the end of a link", async ({ page }, testInfo) => {
    await page.goto("/recover");
    await expect(page.getByText("Get back in.")).toBeVisible();
    await shot(page, testInfo, "recover");

    await page.getByLabel("Email", { exact: true }).fill("someone@keepsake.ing");
    await page.getByLabel("Send the link").click();
    await expect(page.getByText("If we know that address, a link is on its way.")).toBeVisible();
    await shot(page, testInfo, "recover-sent");

    // No inbox in this suite, so these two are captured in the state every
    // real click on an old, reused or mistyped link lands in — which is the
    // state whose copy has been argued over twice (#174, and
    // `app/withdraw/[token].tsx`'s header).
    await page.goto("/recover/not-a-real-token");
    await expect(page.getByText(/link didn.t work/)).toBeVisible();
    await shot(page, testInfo, "recover-bad-link");

    await page.goto("/withdraw/not-a-real-token");
    await expect(page.getByText("That link didn't work")).toBeVisible();
    await shot(page, testInfo, "withdraw-bad-link");

    await page.goto("/no-such-page");
    await expect(page.getByText(/That keepsake isn.t here/)).toBeVisible();
    await shot(page, testInfo, "not-found");
  });

  test("the admin queue, both sides of its gate", async ({ page, request }, testInfo) => {
    await ensureDemoCatalog(request);

    await page.goto("/admin");
    await expect(page.getByText("Enter the admin token")).toBeVisible();
    await shot(page, testInfo, "admin-gate");

    await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
    await page.getByLabel("Enter").click();
    await expect(page.getByRole("tablist", { name: "Queue status" })).toBeVisible();
    await shot(page, testInfo, "admin-queue");

    await page
      .getByRole("tablist", { name: "Queue status" })
      .getByLabel("Hidden", { exact: true })
      .click();
    await expect(page.getByText(DEMO_HIDDEN_LISTING.title, { exact: true })).toBeVisible();
    await shot(page, testInfo, "admin-hidden");
  });

  test("the dark table", async ({ browser, request }, testInfo) => {
    test.skip(
      testInfo.project.name !== DARK_PROJECT,
      `the dark set is captured once, in ${DARK_PROJECT} — a second copy of the same palette is bytes, not evidence`,
    );
    const catalog = await ensureDemoCatalog(request);
    const batch = await ensureDemoBulkBatch(request);

    const context = await openFreshContext(browser, CAPTURE_CONTEXT);
    await seedTheme(context, "dark");
    await seedOwnerToken(context, catalog.ownerToken);
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.getByLabel(DEMO_LISTINGS[0]!.title, { exact: true })).toBeVisible();
    await shot(page, testInfo, "dark-feed");

    await page.goto(`/item/${catalog.ids.letters}`);
    await expect(page.getByText(DEMO_LISTINGS[2]!.title, { exact: true })).toBeVisible();
    await shot(page, testInfo, "dark-item");

    await page.getByLabel("I'd love this").click();
    await expect(page.getByLabel("Note")).toBeVisible();
    await shot(page, testInfo, "dark-item-request-sheet");

    await page.goto("/mine");
    await expect(page.getByText(DEMO_LISTINGS[0]!.title, { exact: true }).first()).toBeVisible();
    await shot(page, testInfo, "dark-mine");

    await page.goto("/give");
    await expect(page.getByText("Show us the keepsake.")).toBeVisible();
    await shot(page, testInfo, "dark-give-photos");

    await page.goto(`/bulk/${batch.clientBatchKey}/photos`);
    await expect(page.getByText("Pressed tin ceiling tile")).toBeVisible();
    await shot(page, testInfo, "dark-bulk-photos");

    await page.goto("/recover");
    await expect(page.getByText("Get back in.")).toBeVisible();
    await shot(page, testInfo, "dark-recover");

    await context.close();
  });
});
