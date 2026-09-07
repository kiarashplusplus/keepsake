/**
 * The stranger's half of the two-sided moment the whole product exists for.
 * Two browser contexts, because the giver is identified by a `localStorage`
 * secret and the requester must not have one — a single context would quietly
 * test the giver asking for their own keepsake.
 *
 * It stops at the confirmation step, and that is the point rather than a gap.
 * Since #188 an ask reaches the giver only after the requester follows a link
 * mailed to the address they gave, and this suite has no inbox: `sendMail()`
 * falls through to its `[email:stub]` log with no `EMAIL` binding wired
 * locally, and the raw token is never in any API response a test could read —
 * the same limitation `withdraw.spec.ts` and `recover.spec.ts` record. So what
 * a browser can prove here is what a browser can prove: the submitter is told
 * to check their email, and the giver's dashboard stays empty until they do.
 *
 * The half that used to live below — choose, and the contact reveal — is
 * covered against the real routes in `apps/api/test/choose.test.ts` and
 * `apps/api/test/requestConfirm.test.ts`, which can mint and redeem a
 * confirmation because they run inside the Worker. Asserting it here would
 * have meant giving the product a way to hand a confirmation token to a
 * caller who never read the mail, which is precisely the hole #188 closed.
 */
import { test, expect, openFreshContext, seedOwnerToken } from "./support/fixtures";
import { createApprovedListing, mintOwnerToken, uniqueTitle } from "./support/api";

test("a stranger asks, is told to confirm by email, and stays invisible to the giver until they do", async ({ browser, request }) => {
  const ownerToken = mintOwnerToken();
  const listing = await createApprovedListing(request, {
    title: uniqueTitle("Enamel brooch"),
    ownerToken,
  });
  const requesterEmail = `asker.${Math.random().toString(36).slice(2, 8)}@keepsake.ing`;
  const note = "My mother wore one exactly like this and I would keep it going for another lifetime.";

  // --- The stranger: a fresh browser, no owner token, its own address ------
  const strangerContext = await openFreshContext(browser);
  const stranger = await strangerContext.newPage();
  await stranger.goto(`/item/${listing.id}`);
  await expect(stranger.getByText(listing.title, { exact: true })).toBeVisible();

  await stranger.getByLabel("I'd love this").click();
  await stranger.getByLabel("Note").fill(note);
  await stranger.getByLabel("Email", { exact: true }).fill(requesterEmail);
  // Issue #64: a neutral date-of-birth prompt, not an "I'm 18 or older"
  // checkbox.
  await stranger.getByLabel("Date of birth").fill("1990-01-01");
  await stranger.getByLabel("Send").click();

  // #188: not "Sent." — the note has not gone anywhere yet, and saying so
  // would be the copy telling a lie the server no longer tells.
  await expect(stranger.getByText("We've emailed you to check it was really you.", { exact: false })).toBeVisible();
  await strangerContext.close();

  // --- The giver: the device that posted it -------------------------------
  const giverContext = await openFreshContext(browser);
  await seedOwnerToken(giverContext, ownerToken);
  const giver = await giverContext.newPage();
  await giver.goto(`/mine/${listing.id}`);

  // The whole of #188 in one assertion: an unconfirmed ask is not merely
  // masked on the giver's screen, it is absent from it. Before the fix a
  // stranger's unverified address appeared right here, looking exactly like a
  // real person, one tap from being sent the giver's own address.
  await expect(giver.getByText(note, { exact: true })).toBeHidden();
  await expect(giver.getByText(requesterEmail, { exact: true })).toBeHidden();
  // And there is nothing to choose, so the reveal cannot be reached at all.
  await expect(giver.getByLabel("Choose")).toBeHidden();

  await giverContext.close();
});

test("the confirmation page does not accept a link the server never issued", async ({ page }) => {
  // Same posture as `withdraw.spec.ts`: an unknown token and a spent one are
  // one answer, so this is the path every real click on a stale link takes.
  await page.goto("/confirm/not-a-real-token");

  await expect(page.getByText("That link didn't work")).toBeVisible();
  await expect(page.getByText("This link is invalid, or it has already been used.", { exact: false })).toBeVisible();
});
