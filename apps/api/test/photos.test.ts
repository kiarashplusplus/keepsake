import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, fakeFile, fakeJpegBytes, freshOwnerToken, readErr, readOk, uploadPhoto } from "./helpers.js";
import type { PublicPhoto } from "@keepsake/contracts/photo";

describe("PUT /api/photos", () => {
  it("uploads full+thumb, sniffs the type, and returns an orphan photo (happy path)", async () => {
    const token = freshOwnerToken();
    const res = await uploadPhoto({ token });
    expect(res.status).toBe(201);
    const data = await readOk<PublicPhoto>(res);
    expect(data.width).toBe(800);
    expect(data.height).toBe(600);
    expect(data.url_full).toBe(`/i/${data.id}/full`);
    expect(data.url_thumb).toBe(`/i/${data.id}/thumb`);

    const row = await env.DB.prepare("SELECT owner_id, listing_id, content_type FROM photos WHERE id = ?")
      .bind(data.id)
      .first<{ owner_id: string; listing_id: string | null; content_type: string }>();
    expect(row?.listing_id).toBeNull();
    expect(row?.content_type).toBe("image/jpeg");
  });

  it("mints an owner on first use (createIfMissing) rather than 401ing a brand-new token", async () => {
    const token = freshOwnerToken();
    const countBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM owners").first<{ n: number }>())?.n ?? 0;

    const res = await uploadPhoto({ token });
    expect(res.status).toBe(201);

    const countAfter = (await env.DB.prepare("SELECT COUNT(*) AS n FROM owners").first<{ n: number }>())?.n ?? 0;
    expect(countAfter).toBe(countBefore + 1);
  });

  it("401s unauthorized with no Authorization header", async () => {
    const form = new FormData();
    form.set("full", fakeFile(fakeJpegBytes(), "full.jpg", "image/jpeg"));
    form.set("thumb", fakeFile(fakeJpegBytes(16), "thumb.jpg", "image/jpeg"));
    form.set("width", "800");
    form.set("height", "600");
    form.set("blurhash", "LEHV6nWB2yk8pyo0adR*.7kCMdnj");
    const res = await SELF.fetch("http://x/api/photos", { method: "PUT", body: form });
    expect(res.status).toBe(401);
    const error = await readErr(res);
    expect(error.code).toBe("unauthorized");
  });

  it("rejects bytes that don't match a known image magic number (415 unsupported_media)", async () => {
    const token = freshOwnerToken();
    const notAnImage = new TextEncoder().encode("not an image, just text padding to look substantial");
    const res = await uploadPhoto({ token, fullBytes: notAnImage, thumbBytes: notAnImage });
    expect(res.status).toBe(415);
    const error = await readErr(res);
    expect(error.code).toBe("unsupported_media");
  });

  it("413s payload_too_large past MAX_PHOTO_BYTES", async () => {
    const token = freshOwnerToken();
    const maxBytes = Number(env.MAX_PHOTO_BYTES);
    const tooBig = fakeJpegBytes(maxBytes + 1);
    const res = await uploadPhoto({ token, fullBytes: tooBig });
    expect(res.status).toBe(413);
    const error = await readErr(res);
    expect(error.code).toBe("payload_too_large");
  });

  // Guard validated by breaking it: temporarily changing the size check in
  // src/routes/photos.ts from `>` to `>=` makes this test fail, because a
  // file exactly at MAX_PHOTO_BYTES would then be wrongly rejected —
  // confirming the test pins the boundary, not just "somewhere near it".
  it("accepts a photo exactly at MAX_PHOTO_BYTES", async () => {
    const token = freshOwnerToken();
    const maxBytes = Number(env.MAX_PHOTO_BYTES);
    const res = await uploadPhoto({ token, fullBytes: fakeJpegBytes(maxBytes) });
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/photos/:id", () => {
  it("deletes an orphan photo owned by the caller", async () => {
    const token = freshOwnerToken();
    const uploadRes = await uploadPhoto({ token });
    const photo = await readOk<PublicPhoto>(uploadRes);

    const deleteRes = await SELF.fetch(`http://x/api/photos/${photo.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(deleteRes.status).toBe(200);

    const row = await env.DB.prepare("SELECT id FROM photos WHERE id = ?").bind(photo.id).first();
    expect(row).toBeNull();
  });

  it("404s for a photo owned by someone else", async () => {
    const ownerA = freshOwnerToken();
    const ownerB = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token: ownerA }));
    // Register ownerB as a real owner first (DELETE doesn't createIfMissing,
    // so an entirely unseen token would 401 before ever reaching the
    // ownership check this test is about).
    await uploadPhoto({ token: ownerB });

    const deleteRes = await SELF.fetch(`http://x/api/photos/${photo.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerB),
    });
    expect(deleteRes.status).toBe(404);
  });
});

describe("GET /i/:id/:variant", () => {
  it("404s a pending listing's photo for an anonymous request", async () => {
    const token = freshOwnerToken();
    const uploadRes = await uploadPhoto({ token });
    const photo = await readOk<PublicPhoto>(uploadRes);

    const res = await SELF.fetch(`http://x/i/${photo.id}/thumb`);
    expect(res.status).toBe(404);
  });

  it("200s the same orphan photo for its own owner's token (preview during review)", async () => {
    const token = freshOwnerToken();
    const uploadRes = await uploadPhoto({ token });
    const photo = await readOk<PublicPhoto>(uploadRes);

    const res = await SELF.fetch(`http://x/i/${photo.id}/thumb`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("404s for an unknown photo id", async () => {
    const res = await SELF.fetch("http://x/i/nonexistent/thumb");
    expect(res.status).toBe(404);
  });
});

/**
 * #181 — `apps/web/src/lib/images/uploadIdempotencyKey.ts` stated as
 * present-tense fact that "retrying the exact same upload reuses the same
 * key and the API's `X-Idempotency-Key` handling can no-op a duplicate
 * rather than creating a second photo row". Both halves were false: the
 * client never sent the header, and this route mounts no `idempotency()`,
 * so nothing would have read it if it had. The module and its five green
 * unit tests are deleted; this asserts what the product actually does
 * instead of leaving it assumed.
 *
 * A live guard, not a monument: mount `idempotency()` on `PUT /api/photos`
 * and this goes red, which is the moment to decide what an upload's key
 * should be. Do not reuse the deleted module's `name:size:lastModified` —
 * it cannot tell a retried upload apart from a giver deliberately adding
 * the same photo twice, and replaying the first response for the second
 * pick hands two draft tiles the same `photo.id`.
 */
describe("PUT /api/photos is not idempotent (#181)", () => {
  it("creates two photo rows for two identical uploads carrying the same X-Idempotency-Key", async () => {
    const token = freshOwnerToken();
    const key = "same-key-both-times";

    async function uploadWithKey(): Promise<PublicPhoto> {
      const form = new FormData();
      const bytes = fakeJpegBytes();
      form.set("full", fakeFile(bytes, "full.jpg", "image/jpeg"));
      form.set("thumb", fakeFile(bytes, "thumb.jpg", "image/jpeg"));
      form.set("width", "800");
      form.set("height", "600");
      form.set("blurhash", "LEHV6nWB2yk8pyo0adR*.7kCMdnj");
      const res = await SELF.fetch("http://x/api/photos", {
        method: "PUT",
        headers: { ...authHeaders(token), "X-Idempotency-Key": key },
        body: form,
      });
      expect(res.status).toBe(201);
      return readOk<PublicPhoto>(res);
    }

    const first = await uploadWithKey();
    const second = await uploadWithKey();

    expect(second.id).not.toBe(first.id);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE id IN (?, ?)")
      .bind(first.id, second.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});
