import { PublicPhoto, type PublicPhoto as PublicPhotoT } from "@keepsake/contracts/photo";
import { apiFetch } from "@/api/client";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

export type UploadPhotoInput = {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  blurhash: string;
  signal?: AbortSignal;
};

/** `PUT /api/photos` — owner-scoped multipart upload. Validated against
 * `PublicPhoto` so a drifted API response fails loudly rather than shipping
 * a malformed photo record into the give flow. */
export async function uploadPhoto(input: UploadPhotoInput): Promise<PublicPhotoT> {
  const form = new FormData();
  form.append("full", input.full, "full.jpg");
  form.append("thumb", input.thumb, "thumb.jpg");
  form.append("width", String(input.width));
  form.append("height", String(input.height));
  form.append("blurhash", input.blurhash);

  const data = await apiFetch<unknown>("/api/photos", {
    method: "PUT",
    body: form,
    owner: true,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  return PublicPhoto.parse(fixPhotoUrls(data));
}

export async function deletePhoto(id: string, signal?: AbortSignal): Promise<void> {
  await apiFetch<unknown>(`/api/photos/${encodeURIComponent(id)}`, {
    method: "DELETE",
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
}
