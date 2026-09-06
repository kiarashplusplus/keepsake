/**
 * The two screens that exist because there are no accounts: attaching an
 * email to a device identity, and asking for a way back to one.
 *
 * Both stop at the point a mailbox would take over. There is no inbox in this
 * suite (and `sendMail()` falls through to its `[email:stub]` log with no
 * `EMAIL` binding wired locally), so the assertions are about the states the
 * product puts the giver in — not about delivery.
 */
import { test, expect, seedOwnerToken } from "./support/fixtures";
import { createApprovedListing, mintOwnerToken, uniqueTitle } from "./support/api";

/** A device that has actually given something, and so has an identity an
 * address can attach to — `GET /api/me` 401s for a token the server has
 * never seen, which is the "give something first" empty state. */
async function giverToken(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const ownerToken = mintOwnerToken();
  await createApprovedListing(request, { title: uniqueTitle("Brass thimble"), ownerToken });
  return ownerToken;
}

test("a giver with an identity gets the email form, not the empty state", async ({ page, context, request }) => {
  await seedOwnerToken(context, await giverToken(request));

  await page.goto("/mine/email");

  await expect(page.getByText("Your email")).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Save")).toBeVisible();
  await expect(page.getByText("Nothing to show yet")).toBeHidden();
});

// FIXME: `POST /api/me/email` answers `{ email, email_verified }`, but
// `src/api/me.ts` parses that with `OwnerMe` (which also requires `id` and
// `banned`) — so the zod parse throws, the catch shows "That didn't go
// through. Try again.", and the unverified state never renders even though
// the address was saved and the verify mail sent. Un-fixme once the route
// returns a full `OwnerMe` (`DELETE /api/me/email`, which returns `{ id }`,
// has the same mismatch).
test.fixme("adding an email leaves the giver in the unverified state", async ({ page, context, request }) => {
  await seedOwnerToken(context, await giverToken(request));
  const email = `giver.${Math.random().toString(36).slice(2, 8)}@example.com`;

  await page.goto("/mine/email");
  await expect(page.getByText("Your email")).toBeVisible();

  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Save").click();

  await expect(page.getByText("Not verified yet — check your inbox, or resend below.")).toBeVisible();
  await expect(page.getByLabel("Resend")).toBeVisible();
});

test("asking for a recovery link never says whether the address is known", async ({ page }) => {
  await page.goto("/recover");
  await expect(page.getByText("Get back in.")).toBeVisible();

  await page.getByLabel("Email", { exact: true }).fill("someone@example.com");
  await page.getByLabel("Send the link").click();

  await expect(page.getByText("If we know that address, a link is on its way.")).toBeVisible();
});
