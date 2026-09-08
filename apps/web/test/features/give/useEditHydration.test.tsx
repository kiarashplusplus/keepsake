import * as React from "react";
import { Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import type { OwnerListingDetail } from "@/api/me";
import { getMyListing } from "@/api/me";
import { GiveDraftProvider, useGiveDraft } from "@/features/give/GiveDraftContext";
import { GIVE_DRAFT_INITIAL, GIVE_DRAFT_STORAGE_KEY, serializeGiveDraft } from "@/features/give/giveDraft";
import { useEditHydration } from "@/features/give/useEditHydration";

// `jest.mock` calls are hoisted above these imports by babel-plugin-jest-hoist
// at transform time, so writing the mocked modules' imports in normal
// top-of-file order still resolves to the mock.
const mockUseGlobalSearchParams = jest.fn<{ edit?: string }, []>();

jest.mock("expo-router", () => ({
  useGlobalSearchParams: () => mockUseGlobalSearchParams(),
}));

jest.mock("@/api/me", () => ({ getMyListing: jest.fn() }));

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function ownerListingDetail(overrides: Partial<OwnerListingDetail> = {}): OwnerListingDetail {
  return {
    id: "01LISTINGEDIT",
    title: "My grandmother's sewing box",
    story: "A story long enough to pass the schema's own minimum length check easily.",
    category: "home_kitchen",
    place_name: "Somerville",
    admin1: "MA",
    country: "US",
    postal_code: "02144",
    status: "pending",
    photos: [
      {
        id: "01PHOTOEDIT",
        width: 800,
        height: 600,
        blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
        url_full: "/i/01PHOTOEDIT/full",
        url_thumb: "/i/01PHOTOEDIT/thumb",
      },
    ],
    aspects: [],
    published_at: 0,
    moderation_reason: null,
    request_count: 0,
    chosen_request_id: null,
    version: 1,
    created_at: 0,
    updated_at: 0,
    held: true,
    category_chosen_at: null,
    staleness: { reasons: [], waiting_since: null },
    requests: [],
    moderation: { status: "pending", held: true },
    ...overrides,
  };
}

let capturedDraft: ReturnType<typeof useGiveDraft>["draft"] | null = null;
let capturedHydrating: boolean | null = null;

function Probe(): React.ReactElement {
  const { draft } = useGiveDraft();
  const { hydrating } = useEditHydration();
  React.useEffect(() => {
    capturedDraft = draft;
    capturedHydrating = hydrating;
  });
  return <Text>{draft.listingId ?? "(none)"}</Text>;
}

function renderProbe() {
  return render(
    <GiveDraftProvider>
      <Probe />
    </GiveDraftProvider>,
  );
}

describe("useEditHydration", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    capturedDraft = null;
    capturedHydrating = null;
    mockUseGlobalSearchParams.mockReset();
    jest.mocked(getMyListing).mockReset();
  });

  it("fetches and hydrates the draft when the URL carries ?edit=, marking the title dirty (#290)", async () => {
    mockUseGlobalSearchParams.mockReturnValue({ edit: "01LISTINGEDIT" });
    jest.mocked(getMyListing).mockResolvedValue(ownerListingDetail());

    renderProbe();

    // Hydrating from the first render, before the fetch resolves (#289).
    expect(capturedHydrating).toBe(true);

    await act(async () => {
      await flush();
    });

    expect(capturedHydrating).toBe(false);
    expect(capturedDraft?.listingId).toBe("01LISTINGEDIT");
    expect(capturedDraft?.title).toBe("My grandmother's sewing box");
    // The title came from a saved listing — a human decision, not an empty
    // slot for a fresh vision suggestion to fill silently on top of.
    expect(capturedDraft?.titleDirty).toBe(true);
  });

  it("stops hydrating (and leaves the draft at its default) when the fetch fails", async () => {
    mockUseGlobalSearchParams.mockReturnValue({ edit: "01LISTINGEDIT" });
    jest.mocked(getMyListing).mockRejectedValue(new Error("network"));

    renderProbe();
    expect(capturedHydrating).toBe(true);

    await act(async () => {
      await flush();
    });

    expect(capturedHydrating).toBe(false);
    expect(capturedDraft?.listingId).toBeNull();
  });

  it("never sets hydrating for a flow entered without ?edit=", async () => {
    mockUseGlobalSearchParams.mockReturnValue({});

    renderProbe();
    await act(async () => {
      await flush();
    });

    expect(capturedHydrating).toBe(false);
    expect(jest.mocked(getMyListing)).not.toHaveBeenCalled();
  });

  // Issue #281: an edit opened and then abandoned (the giver navigated away
  // without submitting) leaves `listingId` — and the rest of that listing's
  // prefill — sitting in `sessionStorage`. The *next* time the flow is
  // entered without `?edit=`, that stale state must not silently carry
  // forward into what looks like a brand new give.
  it("GUARD: clears a stale listingId (and the rest of the prefill) left by an abandoned edit, on a fresh (non-edit) entry", async () => {
    window.sessionStorage.setItem(
      GIVE_DRAFT_STORAGE_KEY,
      serializeGiveDraft({
        ...GIVE_DRAFT_INITIAL,
        listingId: "01LISTINGABANDONED",
        title: "Someone else's listing",
        story: "A story that belongs to the abandoned edit, not to the next give.",
        photos: [
          {
            clientId: "p1",
            id: "01PHOTOABANDONED",
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
    mockUseGlobalSearchParams.mockReturnValue({});

    renderProbe();
    await act(async () => {
      await flush();
    });

    expect(capturedDraft).toEqual(GIVE_DRAFT_INITIAL);
    expect(jest.mocked(getMyListing)).not.toHaveBeenCalled();
  });

  it("does not reset a normal resumed draft (no listingId) on a fresh entry", async () => {
    window.sessionStorage.setItem(
      GIVE_DRAFT_STORAGE_KEY,
      serializeGiveDraft({ ...GIVE_DRAFT_INITIAL, title: "A draft the giver is still filling in" }),
    );
    mockUseGlobalSearchParams.mockReturnValue({});

    renderProbe();
    await act(async () => {
      await flush();
    });

    expect(capturedDraft?.title).toBe("A draft the giver is still filling in");
  });
});
