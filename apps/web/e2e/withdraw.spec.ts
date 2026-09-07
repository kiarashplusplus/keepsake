/**
 * `/withdraw/[token]` — the page a requester lands on from the "withdraw
 * your request" link in the `requestReceived` confirmation email (see
 * `apps/api/src/routes/requestWithdraw.ts`). Same limitation as
 * `recover.spec.ts`'s pair of screens: there is no inbox in this suite
 * (`sendMail()` falls through to its `[email:stub]` log with no `EMAIL`
 * binding wired locally), and the raw token is never returned from any API
 * response a test could read — only mailed. So this only exercises the path
 * every real click on an old, reused, or mistyped link actually takes: the
 * server has never seen this token, or has already spent it. Both look
 * identical from the outside by design (`requestWithdraw.ts`'s "don't
 * distinguish reasons" posture), which is exactly what this asserts.
 */
import { test, expect } from "./support/fixtures";

test("an unknown or already-used token shows the honest 'didn't work' state, not a crash", async ({
  page,
}) => {
  await page.goto("/withdraw/not-a-real-token");

  await expect(page.getByText("That link didn't work")).toBeVisible();
  await expect(
    page.getByText("This link is invalid or has already been used.", { exact: false }),
  ).toBeVisible();

  // The one thing this copy must never say — see app/withdraw/[token].tsx's
  // file header on why softening this would be dishonest about what
  // withdrawing can and can't undo.
  await expect(page.getByText("your data has been deleted", { exact: false })).toBeHidden();
});
