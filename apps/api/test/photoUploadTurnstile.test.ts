/**
 * #183 — `PUT /api/photos` accepts unchallenged uploads even with Turnstile
 * fully configured. This file does **not** assert that the hole is fine. It
 * pins the two facts that together decide whether it can be closed, so that
 * the next session finds out from a red test instead of from givers who
 * cannot upload a photo.
 *
 * Fact 1 (here): with `TURNSTILE_SECRET` set and no `cf-turnstile-response`
 * header, this route answers 201 — it mounts no `turnstile()`.
 * Fact 2 (`apps/web/test/api/photos.test.ts`): `uploadPhoto` sends no
 * `cf-turnstile-response` header, because the give flow's photo step renders
 * no widget — uploads happen on pick, and the only Turnstile widget in the
 * give flow is on the review step five screens later.
 *
 * Mounting `turnstile()` here while fact 2 still holds would 403 the first
 * photo every real giver picks on preview and production, where the secret
 * *is* set and the middleware enforces unconditionally. So: change the
 * client first, then this test, then the route. Whoever does that will
 * delete the first case below and replace it with a `403 turnstile_failed`
 * assertion — that is the intended way for it to fail.
 *
 * The contrast case (`POST /api/listings` at the same instant, same token,
 * no header) is the control from the issue's own evidence: create is
 * correctly blocked, upload is not, so a red first case here can never be
 * blamed on the middleware or the secret being broken.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { authHeaders, freshOwnerToken, readErr, readOk, seedStandardPostalCodes, setTestEnvVar, uploadPhoto } from "./helpers.js";
import type { PublicPhoto } from "@keepsake/contracts/photo";

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  date_of_birth: "1990-01-01",
};

describe("#183: Turnstile coverage of PUT /api/photos", () => {
  afterEach(() => {
    setTestEnvVar("TURNSTILE_SECRET", "");
  });

  it("uploads with no cf-turnstile-response header while the secret is set — the route mounts no turnstile()", async () => {
    setTestEnvVar("TURNSTILE_SECRET", "test-secret");

    // A token that has never been seen before: `ownerAuth({ createIfMissing:
    // true })` mints the `owners` row on sight, so an owner token is not the
    // barrier the middleware's own docblock assumes it is.
    const token = freshOwnerToken();
    const res = await uploadPhoto({ token });

    expect(res.status).toBe(201);
    const photo = await readOk<PublicPhoto>(res);
    expect(photo.url_full).toBe(`/i/${photo.id}/full`);
  });

  it("control: POST /api/listings with the same unchallenged token is refused, so the secret and middleware do work", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("TURNSTILE_SECRET", "test-secret");

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await SELF.fetch("http://x/api/listings", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photo.id] }),
    });

    expect(res.status).toBe(403);
    expect((await readErr(res)).code).toBe("turnstile_failed");
  });
});
