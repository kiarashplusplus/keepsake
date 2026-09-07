import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { PublicListing } from "@keepsake/contracts/listing";
import { ToastProvider } from "@/ui/Toast";
import { getListing } from "@/api/listings";
import Item from "../../../app/item/[id]";

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ id: "listing-1" }),
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/listings", () => ({ getListing: jest.fn() }));

// `Sheet` renders an RN `Modal`, which react-native-web implements via
// `ReactDOM.createPortal` — react-test-renderer (this preset's renderer)
// doesn't support portals ("An invalid container has been provided"), so
// every test that needs to see a sheet's *contents* mocks the wrapper down
// to "render children when visible" and leaves Modal/focus-trap behavior to
// be exercised by Playwright against a real browser instead.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
  };
});

const listing: PublicListing = {
  id: "listing-1",
  title: "Brass compass",
  story: "It pointed the way on a trip I never finished, and now it should point someone else's.",
  category: "other",
  place_name: "Somerville",
  admin1: "MA",
  country: "US",
  status: "approved",
  photos: [
    {
      id: "photo-1",
      width: 800,
      height: 600,
      blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
      url_full: "https://example.com/full.jpg",
      url_thumb: "https://example.com/thumb.jpg",
    },
  ],
  aspects: [],
  published_at: Date.now() - 60_000,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("item/[id]", () => {
  beforeEach(() => {
    jest.mocked(getListing).mockReset();
  });

  it("renders the story and opens the RequestSheet from 'I'd love this'", async () => {
    jest.mocked(getListing).mockResolvedValue(listing);

    const { toJSON, UNSAFE_getByProps } = render(
      <ToastProvider>
        <Item />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("It pointed the way on a trip I never finished");

    const requestButton = UNSAFE_getByProps({ accessibilityLabel: "I'd love this" });
    await act(async () => {
      fireEvent.press(requestButton);
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Tell them why it should be yours");
  });

  it("hides the request button and shows a Given banner for a given listing", async () => {
    jest.mocked(getListing).mockResolvedValue({ ...listing, status: "given" });

    const { toJSON, UNSAFE_queryAllByProps } = render(
      <ToastProvider>
        <Item />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Given");
    expect(UNSAFE_queryAllByProps({ accessibilityLabel: "I'd love this" })).toHaveLength(0);
  });
});
