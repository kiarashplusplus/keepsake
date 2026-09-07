/**
 * The give flow's draft: one object threaded through all five steps,
 * persisted to `sessionStorage` (key below) so a reload or an accidental
 * back-navigation doesn't lose progress. A pure reducer + serialize/
 * deserialize pair, kept separate from the React context
 * (`GiveDraftContext.tsx`) so the state transitions are unit-testable
 * without rendering anything.
 */
import { CATEGORIES, type Category } from "@keepsake/contracts/listing";
import type { Country } from "@keepsake/contracts/geo";
import type { PhotoSuggestion } from "@keepsake/contracts/photo";

function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

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
  /** Set true the moment `set_title` fires at all — even to an empty string
   * on a clear — and never reset. Answers "did the giver type this
   * themselves", which is what `set_suggestion` needs to know before it's
   * allowed to overwrite `title`; `details.tsx`'s `titleTouched` is a
   * *validation* flag (true on blur) and can't answer that question. */
  titleDirty: boolean;
  /**
   * Issue #35: there's no picker for this anymore — the give flow no longer
   * asks the giver to choose one. Always a real `Category`, never `null`:
   * it starts at `"other"` (`GIVE_DRAFT_INITIAL` below) and is overwritten
   * wholesale by whatever the cover photo's suggestion says the moment one
   * lands (`set_suggestion`, below — unlike `title`, there's no "the giver
   * already set it" case to defer to, since nothing in the UI can set it
   * anymore). The column itself stays on `listings` for one more deploy
   * cycle per the issue; this only removes the picker and its dependency
   * on the giver making a choice.
   */
  category: Category;
  country: Country;
  postalCode: string;
  email: string;
  /** Set when editing an existing listing (`/give?edit=<id>`); `null` for a
   * fresh give. */
  listingId: string | null;
  /** Every suggestion fetched so far, keyed by the photo id it was made
   * for — not just the current cover's — so a suggestion already fetched
   * for a photo that's since stopped being the cover isn't refetched if it
   * becomes the cover again. */
  suggestions: Record<string, PhotoSuggestion>;
  /** The photo id whose suggestion last actually changed `title`/`category`
   * (or would have, had they not already been set/dirty). `null` until the
   * first suggestion lands. Compared against the *current* cover photo's id
   * by the UI to decide whether the "filled in from your photo" note (and
   * the story step's condition opener) are still about the photo that's
   * actually showing, or have gone stale because the cover changed. */
  appliedSuggestionPhotoId: string | null;
};

export const GIVE_DRAFT_STORAGE_KEY = "keepsake.giveDraft.v1";

export const GIVE_DRAFT_INITIAL: GiveDraft = {
  photos: [],
  story: "",
  title: "",
  titleDirty: false,
  category: "other",
  country: "US",
  postalCode: "",
  email: "",
  listingId: null,
  suggestions: {},
  appliedSuggestionPhotoId: null,
};

export function makeClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The listing's cover photo: the first successfully-uploaded photo in
 * current order — not necessarily index 0, since a failed first upload
 * shouldn't silently hand "cover" status to an error tile. The single
 * definition shared by the photos step's badge, the review step's image,
 * the `photo_ids` payload order (which already puts the first done photo
 * first, since it's built by filtering in place), and the autofill
 * suggestion's cache key — so "cover photo" can't mean two different things
 * in two different files again.
 */
export function coverPhoto(draft: Pick<GiveDraft, "photos">): GiveDraftPhoto | null {
  return draft.photos.find((photo) => photo.status === "done") ?? null;
}

export type GiveDraftAction =
  | { type: "add_photo"; photo: GiveDraftPhoto }
  | { type: "update_photo"; clientId: string; patch: Partial<GiveDraftPhoto> }
  | { type: "remove_photo"; clientId: string }
  | { type: "move_photo"; clientId: string; direction: -1 | 1 }
  | { type: "set_story"; story: string }
  | { type: "set_title"; title: string }
  | { type: "set_country"; country: Country }
  | { type: "set_postal_code"; postalCode: string }
  | { type: "set_email"; email: string }
  | { type: "set_listing_id"; listingId: string | null }
  | { type: "set_suggestion"; photoId: string; suggestion: PhotoSuggestion }
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
      return { ...state, title: action.title, titleDirty: true };
    case "set_country":
      return { ...state, country: action.country };
    case "set_postal_code":
      return { ...state, postalCode: action.postalCode };
    case "set_email":
      return { ...state, email: action.email };
    case "set_listing_id":
      return { ...state, listingId: action.listingId };
    case "set_suggestion": {
      const suggestions = { ...state.suggestions, [action.photoId]: action.suggestion };
      // A suggestion for a photo that isn't the current cover is worth
      // caching (it may become the cover later, e.g. on reorder) but must
      // never touch `title`/`category` — those follow the cover alone.
      if (coverPhoto(state)?.id !== action.photoId) return { ...state, suggestions };
      return {
        ...state,
        suggestions,
        // Never dispatched as `set_title`, so this never marks `titleDirty`
        // — that flag means "the giver typed this", and an AI prefill isn't
        // that, by design (so a *later*, fresher suggestion — e.g. after a
        // cover change back and forth — can still fill it in).
        title: state.titleDirty ? state.title : action.suggestion.title,
        // Unconditional, unlike `title`: issue #35 removed the picker that
        // used to let a giver "already set" this, so there's no dirty state
        // to preserve — the latest cover's suggestion always wins. Falls
        // back to whatever `state.category` already was (`"other"` by
        // default) if this particular suggestion never named one — not
        // possible today (the schema requires `category`), but cheap
        // insurance against a future suggestion shape that makes it
        // optional.
        category: action.suggestion.category ?? state.category,
        appliedSuggestionPhotoId: action.photoId,
      };
    }
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
      // Blob URLs (`URL.createObjectURL`) die with the document — a value
      // surviving into `sessionStorage` JSON is a dangling reference to a
      // blob no longer registered in this page's memory. Null it out on
      // every rehydrate (a reload, or React re-mounting the provider) so
      // nothing tries to render a revoked/nonexistent object URL; the
      // review step's cover-photo source ladder falls back to `/i/:id/thumb`.
      photos: Array.isArray(parsed.photos) ? (parsed.photos as GiveDraftPhoto[]).map((photo) => ({ ...photo, objectUrl: null })) : [],
      // Issue #35: a draft written to `sessionStorage` by a tab still
      // running the pre-#35 build (or simply reloaded mid-migration) can
      // hold `category: null`, the old sentinel for "nothing picked yet" —
      // no longer a valid `Category` now that the type dropped the `null`
      // arm. `isCategory` narrows it back to a known enum member, falling
      // back to the same `"other"` default a brand-new draft starts at
      // rather than letting an invalid value ride through to `POST
      // /api/listings`, which validates against the real enum anyway.
      category: isCategory(parsed.category) ? parsed.category : GIVE_DRAFT_INITIAL.category,
    };
  } catch {
    return null;
  }
}
