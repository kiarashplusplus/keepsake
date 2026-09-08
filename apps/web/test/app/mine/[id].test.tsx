import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { chooseRequest, getMyListing, type OwnerListingDetail } from "@/api/me";
import { deleteListing, setListingCategory } from "@/api/listings";
import { ApiError } from "@/api/client";
import MineDetail from "../../../app/mine/[id]";

// One router object for the whole file, rather than a fresh `jest.fn()` per
// `useRouter()` call: the delete regression below (issue #172) asserts on
// whether `replace` was called at all, which a per-call mock makes
// unobservable. The `mock` prefix is what lets `babel-plugin-jest-hoist`
// allow the reference from inside the hoisted factory.
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ id: "listing-1" }),
    useRouter: () => mockRouter,
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/me", () => ({ getMyListing: jest.fn(), chooseRequest: jest.fn() }));

jest.mock("@/api/listings", () => ({
  deleteListing: jest.fn(),
  markGiven: jest.fn(),
  relistListing: jest.fn(),
  setListingCategory: jest.fn(),
  withdrawListing: jest.fn(),
}));

// See test/app/item/[id].test.tsx's header comment on why `Sheet` (used by
// both the delete-confirm and Handoff sheets here) is mocked down to "render
// children when visible".
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
  };
});

function baseListing() {
  return {
    id: "listing-1",
    title: "A hand-thrown mug",
    story: "My grandmother made this every morning for forty years, and I finally have to let it go.",
    category: "home_kitchen" as const,
    place_name: "Somerville",
    admin1: "MA",
    country: "US" as const,
    photos: [],
    aspects: [],
    published_at: 0,
  };
}

function detailWithOpenRequest(): OwnerListingDetail {
  return {
    ...baseListing(),
    status: "approved",
    postal_code: "02144",
    moderation_reason: null,
    request_count: 1,
    chosen_request_id: null,
    version: 1,
    created_at: 0,
    updated_at: 0,
    held: false,
    category_chosen_at: null,
    requests: [
      {
        id: "req-1",
        note: "I'd give this a wonderful home on my own kitchen counter.",
        created_at: Date.now() - 60_000,
        status: "open",
        email_masked: "p•••@keepsake.ing",
        notify_failed: false,
      },
    ],
    moderation: { status: "approved", held: false },
  };
}

function detailWithChosenRequest(): OwnerListingDetail {
  const base = detailWithOpenRequest();
  return {
    ...base,
    chosen_request_id: "req-1",
    requests: [
      {
        id: "req-1",
        note: base.requests[0]?.note ?? "",
        created_at: base.requests[0]?.created_at ?? 0,
        status: "chosen",
        email_masked: "p•••@keepsake.ing",
        email: "person@keepsake.ing",
        phone: "+1 555 0100",
        notify_failed: false,
      },
    ],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("mine/[id] choose flow", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
    jest.mocked(chooseRequest).mockReset();
  });

  it("masks the requester's contact until chosen, then reveals it after Choose -> Confirm", async () => {
    jest.mocked(getMyListing).mockResolvedValueOnce(detailWithOpenRequest());

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("p•••@keepsake.ing");
    expect(JSON.stringify(instance.toJSON())).not.toContain("person@keepsake.ing");

    const chooseButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Choose" });
    await act(async () => {
      fireEvent.press(chooseButton);
      await flush();
    });

    // The HandoffSheet's note is optional — confirm without typing one.
    jest.mocked(chooseRequest).mockResolvedValue({
      id: "req-1",
      note: "I'd give this a wonderful home on my own kitchen counter.",
      created_at: Date.now() - 60_000,
      status: "chosen",
      email_masked: "p•••@keepsake.ing",
      email: "person@keepsake.ing",
      phone: "+1 555 0100",
      notify_failed: false,
    });
    jest.mocked(getMyListing).mockResolvedValueOnce(detailWithChosenRequest());

    const confirmButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Confirm" });
    await act(async () => {
      fireEvent.press(confirmButton);
      await flush();
    });

    expect(jest.mocked(chooseRequest)).toHaveBeenCalledWith("listing-1", { request_id: "req-1", handoff_note: "" });
    expect(JSON.stringify(instance.toJSON())).toContain("person@keepsake.ing");
  });

  // Issue #6: a rejected notification used to be indistinguishable from a
  // delivered one anywhere the giver could see — this is the dashboard half
  // of closing that gap. Two cases, since the failure means something
  // different depending on whose address bounced: the giver's own (they
  // never heard about the ask) or the chosen requester's (that person never
  // heard they were picked).
  it("shows a warm notice when the owner-notify failed on an open request", async () => {
    const detail = detailWithOpenRequest();
    const failedRequest = detail.requests[0];
    if (failedRequest === undefined) throw new Error("fixture missing its request");
    detail.requests = [{ ...failedRequest, notify_failed: true }];
    jest.mocked(getMyListing).mockResolvedValueOnce(detail);

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("We couldn't reach you about this one");
  });

  it("shows a warm notice when the chosen-notify failed", async () => {
    const detail = detailWithChosenRequest();
    const failedRequest = detail.requests[0];
    if (failedRequest === undefined) throw new Error("fixture missing its request");
    detail.requests = [{ ...failedRequest, notify_failed: true }];
    jest.mocked(getMyListing).mockResolvedValueOnce(detail);

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("We couldn't reach them to say you chose them");
  });
});

// Issue #172. `runAction` swallowed the error and resolved either way, and
// `handleDelete` chained `.then(() => router.replace("/mine"))` onto it — so a
// DELETE that never reached the API still landed the giver on the dashboard,
// with the error state discarded by the unmount. They were shown a completed
// deletion for a listing that was still public.
describe("mine/[id] delete", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
    jest.mocked(deleteListing).mockReset();
    mockRouter.replace.mockReset();
    mockRouter.push.mockReset();
  });

  async function openDeleteConfirmAndPress(): Promise<ReturnType<typeof render>> {
    jest.mocked(getMyListing).mockResolvedValue(detailWithOpenRequest());

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    // The bare "Delete" on the card opens the confirm sheet; the primary
    // "Delete" inside the sheet is the one that fires the request. `Sheet` is
    // mocked (above) to render its children inline once visible, so after the
    // first press both are on screen — the sheet's is the last.
    const openers = instance.UNSAFE_getAllByProps({ accessibilityLabel: "Delete" });
    const opener = openers[0];
    if (opener === undefined) throw new Error("no Delete control rendered");
    await act(async () => {
      fireEvent.press(opener);
      await flush();
    });

    const confirms = instance.UNSAFE_getAllByProps({ accessibilityLabel: "Delete" });
    const confirm = confirms[confirms.length - 1];
    if (confirm === undefined) throw new Error("no Delete confirm rendered");
    await act(async () => {
      fireEvent.press(confirm);
      await flush();
    });

    return instance;
  }

  it("GUARD: a failed delete does not navigate to /mine, and shows the error", async () => {
    // The exact error `apiFetch`'s catch produces for a dropped connection.
    jest
      .mocked(deleteListing)
      .mockRejectedValue(new ApiError("unavailable", "Couldn't reach Keepsake. Check your connection and try again.", 0));

    const instance = await openDeleteConfirmAndPress();

    expect(jest.mocked(deleteListing)).toHaveBeenCalledWith("listing-1");
    // The whole issue: this used to be called anyway.
    expect(mockRouter.replace).not.toHaveBeenCalled();
    // And the giver is told why, on the page they are still standing on.
    expect(JSON.stringify(instance.toJSON())).toContain("Couldn't reach Keepsake.");
  });

  it("navigates to /mine when the delete actually succeeds", async () => {
    jest.mocked(deleteListing).mockResolvedValue(undefined);

    await openDeleteConfirmAndPress();

    expect(jest.mocked(deleteListing)).toHaveBeenCalledWith("listing-1");
    expect(mockRouter.replace).toHaveBeenCalledWith("/mine");
  });
});

describe("mine/[id] category correction (#155)", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
    jest.mocked(setListingCategory).mockReset();
  });

  async function renderDetail(detail: OwnerListingDetail): Promise<ReturnType<typeof render>> {
    jest.mocked(getMyListing).mockResolvedValue(detail);
    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });
    return instance;
  }

  // Rendered copy is asserted through `toJSON()`, and controls through
  // `UNSAFE_getByProps({ accessibilityLabel })` — the convention the rest of
  // this file already uses, because react-native-web renders `Text` as a
  // `div` and RNTL's text queries never match it.
  it("says the category was guessed, and invites a correction", async () => {
    // The copy is the affordance. "We guessed this" is what tells a giver the
    // single word OTHER on their listing is theirs to fix (#135).
    const instance = await renderDetail(detailWithOpenRequest());
    const tree = JSON.stringify(instance.toJSON());
    expect(tree).toContain("Home & kitchen");
    expect(tree).toContain("We guessed this from your photo.");
  });

  it("says the category is the giver's once they have chosen one", async () => {
    const instance = await renderDetail({ ...detailWithOpenRequest(), category_chosen_at: 1_700_000_000_000 });
    const tree = JSON.stringify(instance.toJSON());
    expect(tree).toContain("You chose this, so we'll leave it alone.");
    expect(tree).not.toContain("We guessed this from your photo.");
  });

  it("sends the giver's pick to the category endpoint, not a full edit", async () => {
    // `setListingCategory`, not `updateListing`: a PATCH would bump the
    // version and re-moderate, taking a live listing out of the feed to
    // change one word.
    jest.mocked(setListingCategory).mockResolvedValue({} as never);
    const instance = await renderDetail(detailWithOpenRequest());

    const opener = instance.UNSAFE_getByProps({ accessibilityLabel: "Change category" });
    await act(async () => {
      fireEvent.press(opener);
      await flush();
    });

    const chip = instance.UNSAFE_getByProps({ accessibilityLabel: "Tools & DIY" });
    await act(async () => {
      fireEvent.press(chip);
      await flush();
    });

    expect(jest.mocked(setListingCategory)).toHaveBeenCalledWith("listing-1", "tools_diy");
  });

  it("offers no correction once the keepsake has been given", async () => {
    const instance = await renderDetail({ ...detailWithOpenRequest(), status: "given" });
    // The section still says what the category is; only the control is gone.
    expect(JSON.stringify(instance.toJSON())).toContain("Home & kitchen");
    expect(instance.UNSAFE_queryByProps({ accessibilityLabel: "Change category" })).toBeNull();
  });
});
