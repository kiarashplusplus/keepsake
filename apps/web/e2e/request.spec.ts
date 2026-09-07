/**
 * The two-sided moment the whole product exists for: a stranger asks, and the
 * giver picks them. Two browser contexts, because the giver is identified by
 * a `localStorage` secret and the requester must not have one — a single
 * context would quietly test the giver asking for their own keepsake.
 */
import { test, expect, openFreshContext, seedOwnerToken } from "./support/fixtures";
import { createApprovedListing, mintOwnerToken, uniqueTitle } from "./support/api";

test("a stranger asks, and the giver chooses them and gets their contact", async ({ browser, request }) => {
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
  await stranger.getByLabel("I'm 18 or older").click();
  await stranger.getByLabel("Send").click();

  await expect(stranger.getByText("Sent. The giver will choose in their own time.")).toBeVisible();
  await strangerContext.close();

  // --- The giver: the device that posted it -------------------------------
  const giverContext = await openFreshContext(browser);
  await seedOwnerToken(giverContext, ownerToken);
  const giver = await giverContext.newPage();
  await giver.goto(`/mine/${listing.id}`);

  await expect(giver.getByText(note, { exact: true })).toBeVisible();
  // Masked until chosen — the real address is not on the page yet.
  await expect(giver.getByText(requesterEmail, { exact: true })).toBeHidden();

  await giver.getByLabel("Choose").click();
  await giver.getByLabel("Handoff note").fill("I'm home most evenings — knock any time after six.");
  await giver.getByLabel("Confirm").click();

  // Choosing is what reveals the contact.
  await expect(giver.getByText(requesterEmail, { exact: true })).toBeVisible();
  await expect(giver.getByText("Chosen", { exact: true })).toBeVisible();

  await giverContext.close();
});
