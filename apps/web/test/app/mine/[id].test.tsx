import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { chooseRequest, getMyListing, type OwnerListingDetail } from "@/api/me";
import MineDetail from "../../../app/mine/[id]";

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ id: "listing-1" }),
    useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/me", () => ({ getMyListing: jest.fn(), chooseRequest: jest.fn() }));

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
