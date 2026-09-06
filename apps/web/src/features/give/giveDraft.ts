/**
 * The give flow's draft: one object threaded through all five steps,
 * persisted to `sessionStorage` (key below) so a reload or an accidental
 * back-navigation doesn't lose progress. A pure reducer + serialize/
 * deserialize pair, kept separate from the React context
 * (`GiveDraftContext.tsx`) so the state transitions are unit-testable
 * without rendering anything.
 */
import type { Category } from "@keepsake/contracts/listing";
import type { Country } from "@keepsake/contracts/geo";

export type GiveDraftPhotoStatus = "uploading" | "done" | "error";

export type GiveDraftPhoto = {
  /** Stable local key, assigned at pick time — survives across the
   * upload's lifecycle even before the API has assigned a real photo id. */
  clientId: string;
  /** The API's photo id once the upload succeeds; `null` while uploading
   * or if it failed. */
  id: string | null;
  /** Local object URL for the thumb, for previewing before/instead of the
   * `/i/:id/thumb` route (which pending photos can't be fetched from in an
   * `<img>` tag — no way to attach the owner token header). `null` after a
   * session reload, since blob URLs don't survive one. */
  objectUrl: string | null;
  width: number;
  height: number;
  blurhash: string;
  status: GiveDraftPhotoStatus;
  error: string | null;
};

export type GiveDraft = {
  photos: GiveDraftPhoto[];
  story: string;
  title: string;
  category: Category | null;
  country: Country;
  postalCode: string;
  email: string;
  /** Set when editing an existing listing (`/give?edit=<id>`); `null` for a
   * fresh give. */
  listingId: string | null;
};

export const GIVE_DRAFT_STORAGE_KEY = "keepsake.giveDraft.v1";

export const GIVE_DRAFT_INITIAL: GiveDraft = {
  photos: [],
  story: "",
  title: "",
  category: null,
  country: "US",
  postalCode: "",
  email: "",
  listingId: null,
};

export function makeClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type GiveDraftAction =
  | { type: "add_photo"; photo: GiveDraftPhoto }
  | { type: "update_photo"; clientId: string; patch: Partial<GiveDraftPhoto> }
  | { type: "remove_photo"; clientId: string }
  | { type: "move_photo"; clientId: string; direction: -1 | 1 }
  | { type: "set_story"; story: string }
  | { type: "set_title"; title: string }
  | { type: "set_category"; category: Category }
  | { type: "set_country"; country: Country }
  | { type: "set_postal_code"; postalCode: string }
  | { type: "set_email"; email: string }
  | { type: "set_listing_id"; listingId: string | null }
  | { type: "hydrate"; draft: GiveDraft }
  | { type: "reset" };

export function giveDraftReducer(state: GiveDraft, action: GiveDraftAction): GiveDraft {
  switch (action.type) {
    case "add_photo":
      return { ...state, photos: [...state.photos, action.photo] };
    case "update_photo":
      return {
        ...state,
        photos: state.photos.map((photo) => (photo.clientId === action.clientId ? { ...photo, ...action.patch } : photo)),
      };
    case "remove_photo":
      return { ...state, photos: state.photos.filter((photo) => photo.clientId !== action.clientId) };
    case "move_photo": {
      const index = state.photos.findIndex((photo) => photo.clientId === action.clientId);
      if (index === -1) return state;
      const target = index + action.direction;
      if (target < 0 || target >= state.photos.length) return state;
      const photos = [...state.photos];
      const moved = photos[index];
      const displaced = photos[target];
      if (moved === undefined || displaced === undefined) return state;
      photos[index] = displaced;
      photos[target] = moved;
      return { ...state, photos };
    }
    case "set_story":
      return { ...state, story: action.story };
    case "set_title":
      return { ...state, title: action.title };
    case "set_category":
      return { ...state, category: action.category };
    case "set_country":
      return { ...state, country: action.country };
    case "set_postal_code":
      return { ...state, postalCode: action.postalCode };
    case "set_email":
      return { ...state, email: action.email };
    case "set_listing_id":
      return { ...state, listingId: action.listingId };
    case "hydrate":
      return action.draft;
    case "reset":
      return GIVE_DRAFT_INITIAL;
    default:
      return state;
  }
}

export function serializeGiveDraft(draft: GiveDraft): string {
  return JSON.stringify(draft);
}

function isGiveDraftShape(value: unknown): value is Partial<GiveDraft> {
  return typeof value === "object" && value !== null;
}

export function deserializeGiveDraft(raw: string): GiveDraft | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isGiveDraftShape(parsed)) return null;
    return {
      ...GIVE_DRAFT_INITIAL,
      ...parsed,
      photos: Array.isArray(parsed.photos) ? (parsed.photos as GiveDraftPhoto[]) : [],
    };
  } catch {
    return null;
  }
}
