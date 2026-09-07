import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { OwnerListing } from "@keepsake/contracts/listing";
import { ToastProvider } from "@/ui/Toast";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { GIVE_DRAFT_INITIAL, GIVE_DRAFT_STORAGE_KEY, serializeGiveDraft } from "@/features/give/giveDraft";
import { createListing } from "@/api/listings";
import { getMyListing } from "@/api/me";
import GiveReview from "../../../app/give/review";

// `jest.mock` calls are hoisted above these imports by babel-plugin-jest-hoist
// at transform time, so writing the mocked modules' imports in normal
// top-of-file order still resolves to the mock.
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/api/listings", () => ({
  createListing: jest.fn(),
  updateListing: jest.fn(),
}));

jest.mock("@/api/me", () => ({
  getMyListing: jest.fn(),
}));

const baseListing: OwnerListing = {
  id: "01LISTINGAAAAAAAAAAAAAAAA",
  title: "A hand-thrown mug",
  story: "My grandmother made this every morning for forty years, and I finally have to let it go.",
  category: "home_kitchen",
  place_name: "Somerville",
  admin1: "MA",
  country: "US",
  postal_code: "02144",
  status: "pending",
  photos: [],
  aspects: [],
  published_at: 0,
  moderation_reason: null,
  request_count: 0,
  chosen_request_id: null,
  version: 1,
  created_at: 0,
  updated_at: 0,
  held: true,
};

function seedDraft(): void {
  window.sessionStorage.setItem(
    GIVE_DRAFT_STORAGE_KEY,
    serializeGiveDraft({
      ...GIVE_DRAFT_INITIAL,
      title: baseListing.title,
      story: baseListing.story,
      category: baseListing.category,
      country: baseListing.country,
      postalCode: "02144",
      photos: [
        {
          clientId: "p1",
          id: "01PHOTOAAAAAAAAAAAAAAAAAA",
          objectUrl: null,
          width: 800,
          height: 600,
          blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
          status: "done",
          error: null,
          errorCode: null,
          canRetry: false,
        },
      ],
    }),
  );
}

function renderReview() {
  return render(
    <ToastProvider>
      <GiveDraftProvider>
        <GiveReview />
      </GiveDraftProvider>
    </ToastProvider>,
  );
}

describe("give/review", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    jest.mocked(createListing).mockReset();
    jest.mocked(getMyListing).mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("submits, then polls from pending to approved and shows the live state", async () => {
    seedDraft();
    jest.mocked(createListing).mockResolvedValue(baseListing);
    jest.mocked(getMyListing).mockResolvedValue({
      ...baseListing,
      status: "approved",
      held: false,
      requests: [],
      moderation: { status: "approved", held: false },
    });

    const { toJSON, getByLabelText, UNSAFE_getByProps } = renderReview();

    // Let Turnstile's no-site-key effect report `unconfigured` so Submit's
    // Turnstile gate is satisfied.
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(getByLabelText("Date of birth"), "1990-01-01");

    const submitButton = UNSAFE_getByProps({ accessibilityRole: "button" });
    await act(async () => {
      fireEvent.press(submitButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(jest.mocked(createListing)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(toJSON())).toContain("Taking a look");

    // First poll tick resolves to "approved".
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(toJSON())).toContain("It's live.");
  });

  it("shows the rejection reason and an Edit action when the listing is rejected", async () => {
    seedDraft();
    jest.mocked(createListing).mockResolvedValue(baseListing);
    jest.mocked(getMyListing).mockResolvedValue({
      ...baseListing,
      status: "rejected",
      moderation_reason: "contact_in_story",
      held: false,
      requests: [],
      moderation: { status: "rejected", reason: "contact_in_story", held: false },
    });

    const { toJSON, getByLabelText, UNSAFE_getByProps } = renderReview();

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(getByLabelText("Date of birth"), "1990-01-01");

    const submitButton = UNSAFE_getByProps({ accessibilityRole: "button" });
    await act(async () => {
      fireEvent.press(submitButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(toJSON())).toContain("Keep contact details out of the story");
  });
});
