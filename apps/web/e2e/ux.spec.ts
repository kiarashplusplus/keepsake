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
 * the whole committed set as a side effect, and a capture run always gets a
 * freshly wiped database rather than one the functional specs have been
 * posting into (`playwright.config.ts` turns `reuseExistingServer` off for
 * exactly that reason).
 *
 * **A state that only this file can produce is not a state.** Everything
 * photographed here is reached the way a visitor reaches it — a URL, a click,
 * a real API call as the owner or the admin. Where a state needed a fixture
 * that did not exist (a postcode with nothing near it, a keepsake already
 * given away, a device with no batches) the fixture was added to
 * `support/global-setup.mjs` / `support/demoCatalog.ts` and the screen was
 * then reached normally, rather than a screen being rendered here that the
 * product cannot reach. Sheets that would change the fixture — the category
 * picker, the delete confirmation, the admin reject sheet — are opened and
 * then dismissed: both projects share one database, so a confirmed one would
 * leave the other project photographing a different product.
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
import {
  ADMIN_TOKEN,
  freshClientIp,
  mintOwnerToken,
  ownerHeaders,
  OWNER_TOKEN_STORAGE_KEY,
} from "./support/api";
import { MODERATION_REASONS } from "@keepsake/contracts/listing";
import { BASE_URL } from "./support/constants";
import { seedConsent } from "./support/consent";
import { seedVisited } from "./support/visited";
import { DEMO_PHOTOS, readDemoPhoto } from "./support/demoPhotos";
import {
  DEMO_GIVEN_LISTING,
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
    // `app/+html.tsx` shows the explainer at `/` to a device with no owner
    // token and no visited flag (in place — it no longer redirects to
    // `/welcome`), so this needs a context with neither.
    const firstVisit = await openUnseededContext(browser);
    // Consent is an independent variable from "has visited before": leave it
    // unseeded and the banner covers the bottom third of the explainer, which
    // is the one screen this frame exists to show. The banner gets its own
    // frame below.
    await seedConsent(firstVisit);
    const welcome = await firstVisit.newPage();
    await welcome.goto("/");
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

    // --- The location controls, with a location actually set ----------------
    // Every frame above is taken at the default "anywhere", where four rows
    // of controls sit behind one summary line on a phone (issue #219) and
    // untouched at the top of the page on a desktop — so the country chips,
    // the postcode field and the radius chips have never been in a frame at
    // either width. The params come from the URL rather than from typing,
    // because that is the state a shared feed link reproduces
    // (`features/feed/feedUrlParams.ts`) and it is the same state at both
    // viewports.
    await page.goto("/?country=US&postal=02144&radius_mi=25");
    await expect(page.getByLabel(DEMO_LISTINGS[5]!.title, { exact: true })).toBeVisible();
    // Narrow only: at 1280 the disclosure button is `display: none` and the
    // `LocationBar` is already open, so this one frame shows the same
    // controls at both widths instead of two different screens.
    const changeLocation = page.getByLabel(/^Near · 25 mi of 02144/);
    if (await changeLocation.isVisible()) await changeLocation.click();
    await expect(page.getByLabel("Postcode")).toHaveValue("02144");
    // Framed on the last row of the controls rather than the top of the page:
    // at 1280 the hero and the chips fill the fold, so without this the frame
    // is `feed` again with a "Near" eyebrow at the bottom edge. A no-op at
    // 390px, where the expanded panel is already on screen.
    await page.getByLabel("Anywhere", { exact: true }).scrollIntoViewIfNeeded();
    await shot(page, testInfo, "feed-location");

    // --- Nothing near you ---------------------------------------------------
    // The third of `features/feed/emptyState.ts`'s three empty states, and
    // the only one with no frame: not an empty catalogue, not a search that
    // missed, but a radius that is genuinely too tight. Every keepsake this
    // suite seeds is in eastern Massachusetts, so it takes a postcode a long
    // way from them — `global-setup.mjs` seeds 99501 for exactly this, and
    // nothing is ever listed there.
    await page.goto("/?country=US&postal=99501&radius_mi=10");
    await expect(page.getByText(/Nothing within 10 mi of 99501/)).toBeVisible();
    // Framed on the button rather than the heading: this state's whole
    // argument is that it offers a way out of itself (#220), and at 390px
    // the two actions are a screenful below the words.
    const widen = page.getByLabel("Widen to 25 mi");
    await expect(widen).toBeVisible();
    await widen.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "feed-radius-empty");
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

    // The keepsake somebody already has. `GET /api/listings/:id` answers for
    // `given` as well as `approved`, so this is a live page a stranger still
    // reaches from an old link or a card that unfurled in a group chat — and
    // it is the only item page with a `Given` stamp under the print and no
    // way to ask for it. `demoCatalog.ts` keeps one listing permanently in
    // that state; the feed never shows it.
    await page.goto(`/item/${catalog.givenId}`);
    await expect(page.getByText(DEMO_GIVEN_LISTING.title, { exact: true })).toBeVisible();
    await expect(page.getByLabel("I'd love this")).toHaveCount(0);
    // #359: the stamp is not the only thing that says so any more. The card
    // says it in words and offers a way onward, and Share is no longer the
    // action a stranger is led with — assert all three here so the frame
    // below is a frame of that page and not of the one it replaced.
    await expect(page.getByText("This one has found a home.")).toBeVisible();
    await expect(page.getByLabel("See what else is nearby")).toHaveAttribute("href", "/");
    // Stacked at 390px the stamp is below the print, which is the half of
    // this screen the frame is for.
    const givenStamp = page.getByText("Given", { exact: true });
    await expect(givenStamp).toBeVisible();
    await givenStamp.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "item-given");
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

    await expect(page.getByText("Where should we reach you?")).toBeVisible();
    await page.getByLabel("Email").fill("giver@keepsake.ing");
    await shot(page, testInfo, "give-4-email");
    await onScreen(page, "Continue").click();

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

    // --- A listing nobody has asked for yet ---------------------------------
    // The frames below are the same screen with two requests on it, which is
    // what this dashboard is *for* — but every listing starts here, and this
    // is where the status line, the giver's category correction (#155) and
    // the owner actions live with nothing in front of them. `plane` is used
    // because neither project ever sends a request to it.
    await page.goto(`/mine/${catalog.ids.plane}`);
    await expect(page.getByText(DEMO_LISTINGS[3]!.title, { exact: true })).toBeVisible();
    await shot(page, testInfo, "mine-detail");

    // The model picked this category and the giver is allowed to disagree
    // (#155) — a picker that has never been in a frame. Opened and then
    // dismissed: choosing here would rewrite the fixture's category and the
    // *other* project would photograph a different card.
    await page.getByLabel("Change category").click();
    await expect(page.getByText("What is it?", { exact: true })).toBeVisible();
    await shot(page, testInfo, "mine-detail-category");
    await page.keyboard.press("Escape");

    // The one destructive confirmation in the product a giver can reach.
    // Opened from the page's own Delete (`.first()` — the sheet renders a
    // second button with the same label) and cancelled, never confirmed.
    await page.getByLabel("Delete", { exact: true }).first().click();
    await expect(page.getByText("This can't be undone.")).toBeVisible();
    await shot(page, testInfo, "mine-detail-delete");
    await page.getByLabel("Cancel", { exact: true }).click();

    // And the end state: given away, so there is nothing left to choose, no
    // category to correct and no withdrawing it.
    await page.goto(`/mine/${catalog.givenId}`);
    await expect(page.getByText(DEMO_GIVEN_LISTING.title, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Mark given")).toHaveCount(0);
    await shot(page, testInfo, "mine-detail-given");

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

    // The four frames below need a request the giver can actually see. Since
    // #188 there is no way to produce that by clicking through the product
    // itself — an ask is held until the stranger clicks a link that only
    // exists in an email, and `request.spec.ts` is explicit that not being
    // able to reach that token from a test is the point, not a gap. So
    // `demoCatalog.ts` confirms its own two requests directly in D1 instead
    // (issue #240) — the same mechanism issue #225 already uses to pin
    // listing ids, never a route the real app could also reach.
    const firstNote = page.getByText(DEMO_REQUESTS[0]!.note, { exact: true });
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

  test("the estate bulk workspace", async ({ page, context, request, browser }, testInfo) => {
    // New with the bulk-upload pilot (PR #263) — `ensureDemoBulkBatch`
    // seeds one batch for `DEMO_OWNER_TOKEN`: two photos grouped into a
    // filled-in, ready item, and a third left unassigned in the tray, so
    // Photos shows both halves of "add and group" at once rather than an
    // empty or an all-grouped tray.
    const batch = await ensureDemoBulkBatch(request);
    await seedOwnerToken(context, DEMO_OWNER_TOKEN);

    await page.goto("/bulk");
    await expect(page.getByText("Give several items")).toBeVisible();
    await expect(page.getByText("UX baseline — estate batch", { exact: true })).toBeVisible();
    await shot(page, testInfo, "bulk-batches");

    // The same screen before there is anything to list — the invitation card
    // alone, which is what every first visit to `/bulk` looks like and is a
    // different page from the one above at 390px. A freshly minted owner
    // token is a device the server has never seen: `GET /api/bulk/batches`
    // answers 401 and `app/bulk/index.tsx` renders that as the honest empty
    // list rather than an error (see its `unauthorized` branch).
    const newcomer = await openFreshContext(browser, CAPTURE_CONTEXT);
    await seedOwnerToken(newcomer, mintOwnerToken());
    const newcomerPage = await newcomer.newPage();
    await newcomerPage.goto("/bulk");
    await expect(newcomerPage.getByLabel("Start a new batch")).toBeVisible();
    await expect(newcomerPage.getByText("UX baseline — estate batch")).toHaveCount(0);
    // A context this fresh loads the route's own split chunk cold, and
    // `useChunkRecoveryGuard` (#272) reloads the page once if that fetch
    // loses its race — which lands inside `shot()` as "execution context
    // destroyed" rather than as a failed assertion. Letting the network go
    // quiet first puts that reload, if it happens at all, before the
    // capture instead of during it.
    await newcomerPage.waitForLoadState("networkidle");
    await shot(newcomerPage, testInfo, "bulk-batches-empty");
    await newcomer.close();

    // Started, not submitted: a filled name and postcode, one tap from
    // creating a *second* batch — which this frame deliberately never does,
    // so the fixture stays idempotent across runs.
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

    // `/confirm/:token` is the step that makes a request real (#188), and
    // the whole route was missing from this baseline. Same reason as the two
    // below: there is no inbox here, so the state every stale, reused or
    // mistyped link lands in is the one a capture can show — and it is the
    // one whose copy has to carry the weight.
    await page.goto("/confirm/not-a-real-token");
    await expect(page.getByText("That link didn't work")).toBeVisible();
    // #357: the card used to be the whole page, with nothing on it to press.
    // Assert the way onward is there, and is a real link, so the frame below
    // is a frame of the page with it and not of the dead end it replaced.
    await expect(page.getByLabel("Back to the feed")).toHaveAttribute("href", "/");
    await shot(page, testInfo, "confirm-bad-link");

    await page.goto("/withdraw/not-a-real-token");
    await expect(page.getByText("That link didn't work")).toBeVisible();
    await expect(page.getByLabel("Back to the feed")).toHaveAttribute("href", "/");
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
    const queueTabs = page.getByRole("tablist", { name: "Queue status" });
    await expect(queueTabs).toBeVisible();
    await shot(page, testInfo, "admin-queue");

    // The queue the frame above is named after is not in it: at both
    // viewports `StatsStrip` fills the fold, so `admin-queue` is eleven
    // counters and the crons. This is what is under them — the two tablists
    // and the tab a moderator opens on. `MOCK_AI` approves everything this
    // suite seeds, so "Needs review" is legitimately clear, which is also
    // the state it is in on most real days.
    await queueTabs.scrollIntoViewIfNeeded();
    await expect(page.getByText("Nothing waiting.")).toBeVisible();
    await shot(page, testInfo, "admin-queue-empty");

    await queueTabs.getByLabel("Hidden", { exact: true }).click();
    await expect(page.getByText(DEMO_HIDDEN_LISTING.title, { exact: true })).toBeVisible();
    await shot(page, testInfo, "admin-hidden");

    // Selection and the bulk toolbar it raises. Neither had a frame, and the
    // bar is a band of `accentSoft` with an outlined toolbar on it that
    // exists on no other screen in the product.
    await page.getByLabel(`Select ${DEMO_HIDDEN_LISTING.title}`).click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await shot(page, testInfo, "admin-hidden-selected");
    await page.getByLabel("Clear selection").click();

    // The reject sheet — the one moderation control that is a closed list of
    // reasons rather than a free-text box, and the longest sheet in the
    // product. Opened from the card and dismissed with Escape: confirming it
    // would reject the fixture the Hidden tab is captured against, and the
    // other project runs against the same database.
    // Captured with a reason picked: the chips carry short moderator-facing
    // labels since #354, and the giver-facing sentence only appears under
    // the row once one is chosen — that pairing is the sheet's whole design.
    await page.getByLabel("Reject", { exact: true }).click();
    await expect(page.getByText("Reject this listing", { exact: true })).toBeVisible();
    await page.getByRole("radiogroup").getByLabel("Not an object", { exact: true }).click();
    await expect(page.getByText(MODERATION_REASONS.not_an_object, { exact: true })).toBeVisible();
    await shot(page, testInfo, "admin-reject-sheet");
    await page.keyboard.press("Escape");

    // The Observatory (the other half of `/admin`, behind the section
    // tablist) has never been photographed at all. Locally most of its
    // sources are unconfigured — there is no Analytics Engine behind
    // `wrangler dev` — and that is worth a frame in itself: "not configured"
    // and "the call failed" are drawn differently on purpose
    // (`Observatory.tsx`'s header), and this is the only place to see that
    // distinction rendered rather than described.
    await page.getByRole("tablist", { name: "Admin sections" }).getByLabel("Observatory").click();
    const moderationHeading = page.getByText("Moderation", { exact: true });
    await expect(moderationHeading).toBeVisible();
    await shot(page, testInfo, "admin-observatory");

    // The panel reads top to bottom in a deliberate order and the frame above
    // only reaches the first section of it. This is the half made of badge
    // grids and age rows, which is a different layout problem from the alert
    // cards above them.
    await moderationHeading.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "admin-observatory-app");
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

    // The giver's own detail page in the dark: an index card, a status
    // eyebrow in one of seven colours, and four buttons in three variants —
    // more of the palette on one screen than anything else the dark set
    // photographs.
    await page.goto(`/mine/${catalog.ids.plane}`);
    await expect(page.getByText(DEMO_LISTINGS[3]!.title, { exact: true })).toBeVisible();
    await shot(page, testInfo, "dark-mine-detail");

    // An empty state and a rubber stamp with no photograph anywhere near
    // them — the one composition on the dark table that has nothing but ink
    // and paper to hold it up.
    await page.goto("/no-such-page");
    await expect(page.getByText(/That keepsake isn.t here/)).toBeVisible();
    await shot(page, testInfo, "dark-not-found");

    // `/admin` in the dark, which is where the palette is under the most
    // pressure: eleven outlined counters, two rows of chips and the red
    // cron badges, none of which appear anywhere else in the product.
    await page.goto("/admin");
    await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
    await page.getByLabel("Enter").click();
    await expect(page.getByRole("tablist", { name: "Queue status" })).toBeVisible();
    await shot(page, testInfo, "dark-admin");

    await context.close();
  });
});
