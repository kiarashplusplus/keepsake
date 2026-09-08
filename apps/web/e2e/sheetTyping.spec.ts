/**
 * Typing inside a sheet, with real keystrokes.
 *
 * Every other spec fills sheet fields with Playwright's `fill()`, which sets
 * the value in one shot and dispatches no per-key events. That is why the bug
 * this covers reached production twice: the first space of a note or an email
 * address closed the sheet and dismissed the keyboard, and nothing in the
 * suite ever pressed a space bar to notice.
 *
 * The cause was structural. The backdrop carries
 * `accessibilityRole="button"`, which react-native-web renders as a real
 * `<button>`; while it wrapped the panel, every field in the sheet was a
 * descendant of that button, and a space typed into a field activated it.
 * `src/ui/Sheet.tsx` now renders the backdrop as a sibling of the panel.
 */
import { test, expect, openFreshContext } from "./support/fixtures";
import { createApprovedListing, uniqueTitle } from "./support/api";

test("a space typed into a sheet field neither closes the sheet nor drops focus", async ({
  browser,
  request,
}) => {
  const listing = await createApprovedListing(request, { title: uniqueTitle("Sheet typing") });
  const context = await openFreshContext(browser);
  const page = await context.newPage();

  await page.goto(`/item/${listing.id}`);
  await page.getByLabel("I'd love this").click();

  // Typed, not filled — the space bar is the whole point.
  const note = page.getByLabel("Note");
  await note.click();
  await page.keyboard.type("a keepsake worth keeping");

  await expect(note).toHaveValue("a keepsake worth keeping");
  await expect(note).toBeFocused();
  // The sheet is still open, rather than having closed on the first space.
  await expect(page.getByLabel("Send")).toBeVisible();

  // The email field is the other one a giver reported losing: same keystroke
  // path, and an address always contains characters typed after a space in
  // the field above it.
  const email = page.getByLabel("Email", { exact: true });
  await email.click();
  await page.keyboard.type("someone@example.com");
  await expect(email).toHaveValue("someone@example.com");
  await expect(email).toBeFocused();

  // The backdrop still closes the sheet when it is actually pressed — the fix
  // moved it beside the panel, it did not remove it.
  await page.getByLabel("Close").click({ position: { x: 5, y: 5 } });
  await expect(page.getByLabel("Send")).toBeHidden();
});
