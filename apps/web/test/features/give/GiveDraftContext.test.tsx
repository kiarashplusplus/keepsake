import * as React from "react";
import { Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { GiveDraftProvider, useGiveDraft } from "@/features/give/GiveDraftContext";
import { GIVE_DRAFT_INITIAL, GIVE_DRAFT_STORAGE_KEY, deserializeGiveDraft, type GiveDraftAction } from "@/features/give/giveDraft";

let capturedDispatch: React.Dispatch<GiveDraftAction> | null = null;

function Probe(): React.ReactElement {
  const { draft, dispatch } = useGiveDraft();
  // Captured in an effect, not the render body: `dispatch` is stable across
  // renders, and writing to module-scope state during render (rather than
  // as a side effect) is exactly what react-hooks' purity rule flags.
  React.useEffect(() => {
    capturedDispatch = dispatch;
  }, [dispatch]);
  return <Text>{draft.title || "(empty)"}</Text>;
}

describe("GiveDraftProvider", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    capturedDispatch = null;
  });

  it("persists dispatched changes to sessionStorage under the draft key", () => {
    render(
      <GiveDraftProvider>
        <Probe />
      </GiveDraftProvider>,
    );

    expect(capturedDispatch).not.toBeNull();
    act(() => {
      capturedDispatch?.({ type: "set_title", title: "Grandmother's mug" });
    });

    const raw = window.sessionStorage.getItem(GIVE_DRAFT_STORAGE_KEY);
    expect(deserializeGiveDraft(raw ?? "")?.title).toBe("Grandmother's mug");
  });

  it("hydrates from whatever draft is already in sessionStorage on mount", () => {
    window.sessionStorage.setItem(GIVE_DRAFT_STORAGE_KEY, JSON.stringify({ ...GIVE_DRAFT_INITIAL, title: "Already saved" }));

    const { toJSON } = render(
      <GiveDraftProvider>
        <Probe />
      </GiveDraftProvider>,
    );

    expect(JSON.stringify(toJSON())).toContain("Already saved");
  });
});
