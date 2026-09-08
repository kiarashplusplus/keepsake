import * as React from "react";
import { Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { GiveDraftProvider, useGiveDraft } from "@/features/give/GiveDraftContext";
import type { GiveDraftAction } from "@/features/give/giveDraft";
import { SuggestionFetcher } from "@/features/give/SuggestionFetcher";
import { suggestPhoto } from "@/api/photos";

jest.mock("@/api/photos", () => ({ suggestPhoto: jest.fn() }));

const SUGGESTION = {
  subject: "a ceramic mug",
  markings: "",
  title: "Blue ceramic mug",
  category: "home_kitchen" as const,
  condition: "small chip near the handle",
  aspects: [],
};

let capturedDispatch: React.Dispatch<GiveDraftAction> | null = null;

function Probe(): React.ReactElement {
  const { draft, dispatch } = useGiveDraft();
  React.useEffect(() => {
    capturedDispatch = dispatch;
  }, [dispatch]);
  return <Text>{draft.title}</Text>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function addCoverPhoto(): void {
  capturedDispatch?.({
    type: "add_photo",
    photo: {
      clientId: "a",
      id: "01PHOTOCOVER",
      objectUrl: null,
      width: 10,
      height: 10,
      blurhash: "x",
      status: "done",
      error: null,
      errorCode: null,
      canRetry: false,
    },
  });
}

describe("SuggestionFetcher", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    capturedDispatch = null;
    jest.mocked(suggestPhoto).mockReset();
  });

  it("fetches a suggestion for the cover photo once it's done, and applies it to the draft", async () => {
    jest.mocked(suggestPhoto).mockResolvedValue(SUGGESTION);

    const { toJSON } = render(
      <GiveDraftProvider>
        <SuggestionFetcher />
        <Probe />
      </GiveDraftProvider>,
    );

    await act(async () => {
      addCoverPhoto();
      await flush();
    });

    expect(jest.mocked(suggestPhoto)).toHaveBeenCalledWith("01PHOTOCOVER");
    // `getByText`/`getByRole` don't reliably match react-native-web's
    // react-test-renderer output at these pinned library versions (see
    // test/ui/Button.test.tsx's header comment) — matching the serialized
    // tree is the established workaround used throughout this suite.
    expect(JSON.stringify(toJSON())).toContain("Blue ceramic mug");
  });

  it("does not fetch twice for the same cover id across re-renders", async () => {
    jest.mocked(suggestPhoto).mockResolvedValue(SUGGESTION);

    const { rerender } = render(
      <GiveDraftProvider>
        <SuggestionFetcher />
        <Probe />
      </GiveDraftProvider>,
    );

    await act(async () => {
      addCoverPhoto();
      await flush();
    });
    expect(jest.mocked(suggestPhoto)).toHaveBeenCalledTimes(1);

    // A re-render with the same cover id (e.g. an unrelated draft field
    // changing) must not re-trigger the request.
    await act(async () => {
      capturedDispatch?.({ type: "set_story", story: "irrelevant" });
      await flush();
    });
    rerender(
      <GiveDraftProvider>
        <SuggestionFetcher />
        <Probe />
      </GiveDraftProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(jest.mocked(suggestPhoto)).toHaveBeenCalledTimes(1);
  });

  it("a failed suggestion request leaves the draft untouched", async () => {
    jest.mocked(suggestPhoto).mockRejectedValue(new Error("network"));

    render(
      <GiveDraftProvider>
        <SuggestionFetcher />
        <Probe />
      </GiveDraftProvider>,
    );

    await act(async () => {
      addCoverPhoto();
      await flush();
    });

    expect(jest.mocked(suggestPhoto)).toHaveBeenCalledTimes(1);
  });

  // Issue #290: a give flow with a `listingId` is editing (or resubmitting)
  // an existing listing, whose cover photo the giver already chose. A fresh
  // vision call there would only spend `SUGGEST` budget for a suggestion
  // nothing needs — and, absent this guard, would still overwrite
  // `category` even with `useEditHydration`'s `titleDirty: true` protecting
  // `title` (the reducer's `set_suggestion` case has no dirty flag for
  // category — see `giveDraft.ts`).
  it("never fetches once the draft has a listingId (mid-edit or resubmitting)", async () => {
    jest.mocked(suggestPhoto).mockResolvedValue(SUGGESTION);

    render(
      <GiveDraftProvider>
        <SuggestionFetcher />
        <Probe />
      </GiveDraftProvider>,
    );

    await act(async () => {
      capturedDispatch?.({ type: "set_listing_id", listingId: "01LISTINGEDIT" });
      addCoverPhoto();
      await flush();
    });

    expect(jest.mocked(suggestPhoto)).not.toHaveBeenCalled();
  });
});
