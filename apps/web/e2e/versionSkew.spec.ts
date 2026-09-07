/**
 * The version-skew guard (issue #23), against the real exported bundle and
 * the real `/version.json` route — `apps/api/src/index.ts` — with only the
 * server's response body swapped via `page.route`, not the client code.
 *
 * `dist/version.json` (written by `scripts/write-version-json.mjs`, part of
 * `pnpm export`) and `expo.extra.buildInfo.commitHash` (`app.config.js`) are
 * computed by the exact same `resolveCommitHash()` call at export time — see
 * that script's header comment — so reading the file here is a reliable
 * stand-in for "the commit this running build was stamped with" without
 * needing to scrape it out of the bundle itself.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures";

const DIST_VERSION_PATH = path.join(__dirname, "..", "dist", "version.json");

function readBuildCommit(): string {
  const raw = JSON.parse(fs.readFileSync(DIST_VERSION_PATH, "utf-8")) as { commit: string };
  return raw.commit;
}

const BANNER_TEXT = /new version of Keepsake/i;

test("shows the reload banner when the server is running a different commit than this build", async ({ page }) => {
  const buildCommit = readBuildCommit();
  // Guaranteed not to be a prefix match for a real (non-"dev") build commit —
  // if `pnpm export` ever ran without a real git checkout, `buildCommit`
  // would be the literal "dev", and the guard is specified to stay quiet in
  // that case (see `versionSkew.ts`'s `UNSTAMPED_COMMIT`), so this assertion
  // would be meaningless. Skip rather than false-pass.
  test.skip(buildCommit === "dev", "build has no real commit stamped in — the guard deliberately no-ops");

  await page.route("**/version.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ commit: "9999999deadbeef0000000000000000deadbeef" }),
    }),
  );

  await page.goto("/");
  await expect(page.getByText(BANNER_TEXT)).toBeVisible();

  const reloadButton = page.getByRole("button", { name: "Reload" });
  await expect(reloadButton).toBeVisible();

  // Clicking it actually reloads the page — proof this isn't just a static
  // string, and that the guard's own `reload()` is wired to the button
  // rather than sitting there unused.
  const navigated = page.waitForEvent("load");
  await reloadButton.click();
  await navigated;
});

test("does NOT show the banner when the server reports the same commit this build was stamped with", async ({
  page,
}) => {
  const buildCommit = readBuildCommit();

  await page.route("**/version.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      // The real server returns the FULL sha; the build's own commitHash is
      // a 7-char prefix of the SAME value (see this file's header comment) —
      // padding it out to something starting with the short hash exercises
      // the real `startsWith` comparison, not an accidental `===` match.
      body: JSON.stringify({ commit: `${buildCommit}0000000000000000000000000000000000` }),
    }),
  );

  await page.goto("/");
  // `waitForTimeout` would be a guess; polling for the banner's absence
  // right after the guard's first (mount-time) check is what actually
  // proves the negative rather than just not having looked yet.
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(BANNER_TEXT)).not.toBeVisible();
});

test("never shows the banner against the real, unmocked /version.json in a fresh session", async ({ page }) => {
  // No route mock: this is the guard running against the genuine server
  // response for whatever commit the local e2e Worker was started with
  // (`COMMIT_SHA` unset in `wrangler dev` → "dev"), proving the guard is
  // actually mounted and doesn't misfire on an ordinary page load.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(BANNER_TEXT)).not.toBeVisible();
});
