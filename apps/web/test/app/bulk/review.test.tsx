import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { makeBulkDraftItem, makeBulkDraftPhoto } from "@/features/bulk/batchStore";
import { makeWorkspaceFixture, fixtureBatchState } from "../../support/bulkWorkspaceFixture";
import BulkReview from "../../../app/bulk/[batchKey]/review";

let mockWorkspace = makeWorkspaceFixture();

jest.mock("@/features/bulk/BulkWorkspaceContext", () => ({
  useBulkWorkspaceContext: () => mockWorkspace,
}));

// See `test/features/request/RequestSheet.test.tsx`'s identical mock and
// its own comment: RN `Modal`'s portal isn't supported by react-test-renderer.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
  };
});

/** jsdom reports `document.documentElement.clientWidth` as 0 — see
 * `test/app/index.test.tsx`'s identical helper and its header comment. This
 * screen's own narrow/wide split (one expanded card vs. a compact list) is
 * keyed on exactly this, so every test below sets a desktop width unless
 * it's specifically testing the narrow branch. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window.document.documentElement, "clientWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

function itemWithOnePhoto(clientItemId: string, patch: Partial<ReturnType<typeof makeBulkDraftItem>> = {}) {
  return { ...makeBulkDraftItem(clientItemId, 1000), photoClientIds: [`${clientItemId}-photo`], ...patch };
}

describe("bulk review screen", () => {
  beforeEach(() => {
    mockWorkspace = makeWorkspaceFixture();
    setViewportWidth(1280);
  });

  it("shows an empty prompt when nothing has been grouped yet", () => {
    mockWorkspace = makeWorkspaceFixture({ state: fixtureBatchState() });
    const { toJSON } = render(<BulkReview />);
    expect(JSON.stringify(toJSON())).toContain("Nothing grouped yet");
  });

  it("renders one card per item with the ready/need-details summary", () => {
    const state = fixtureBatchState({
      items: {
        "item-a": itemWithOnePhoto("item-a", { fields: { title: "Blue mug" }, ready: true }),
        "item-b": itemWithOnePhoto("item-b", { ready: false, blockedReason: "Add a story." }),
      },
      itemOrder: ["item-a", "item-b"],
      photos: {
        "item-a-photo": { ...makeBulkDraftPhoto("item-a-photo", { itemClientId: "item-a" }, 1000) },
        "item-b-photo": { ...makeBulkDraftPhoto("item-b-photo", { itemClientId: "item-b" }, 1000) },
      },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    const { toJSON } = render(<BulkReview />);
    const json = JSON.stringify(toJSON());
    expect(json).toContain("1 ready");
    expect(json).toContain("1 need details");
    expect(json).toContain("Add a story.");
  });

  it("routes a title edit through setItemTitle, preserving the human-choice marker upstream", () => {
    const state = fixtureBatchState({
      items: { "item-a": itemWithOnePhoto("item-a") },
      itemOrder: ["item-a"],
      photos: { "item-a-photo": makeBulkDraftPhoto("item-a-photo", { itemClientId: "item-a" }, 1000) },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkReview />);

    fireEvent.changeText(screen.getByLabelText("Title"), "Nan's blue mug");
    expect(mockWorkspace.setItemTitle).toHaveBeenCalledWith("item-a", "Nan's blue mug");
  });

  it("routes a category pick through setItemCategory", () => {
    const state = fixtureBatchState({
      items: { "item-a": itemWithOnePhoto("item-a") },
      itemOrder: ["item-a"],
      photos: { "item-a-photo": makeBulkDraftPhoto("item-a-photo", { itemClientId: "item-a" }, 1000) },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkReview />);

    fireEvent.press(screen.getByLabelText("Home & kitchen"));
    expect(mockWorkspace.setItemCategory).toHaveBeenCalledWith("item-a", "home_kitchen");
  });

  it("opens the apply-to-selected sheet only once an item is selected, and previews the shared story", async () => {
    const state = fixtureBatchState({
      items: { "item-a": itemWithOnePhoto("item-a", { fields: { title: "Blue mug" } }) },
      itemOrder: ["item-a"],
      photos: { "item-a-photo": makeBulkDraftPhoto("item-a-photo", { itemClientId: "item-a" }, 1000) },
    });
    const preview = jest.fn(() => [{ itemClientId: "item-a", title: "Blue mug", before: "", after: "Everything here belonged to my mother.", skipped: false, reason: null }]);
    mockWorkspace = makeWorkspaceFixture({ state, previewSharedStoryApplication: preview });
    render(<BulkReview />);

    expect(screen.queryByLabelText("Apply to 1 selected")).toBeNull();

    fireEvent.press(screen.getByLabelText("Select"));
    const applyButton = screen.getByLabelText("Apply to 1 selected");
    await act(async () => {
      fireEvent.press(applyButton);
      await Promise.resolve();
    });

    expect(preview).toHaveBeenCalledWith(["item-a"]);
    const applyAllButton = screen.getByLabelText("Apply to 1 item");
    fireEvent.press(applyAllButton);
    expect(mockWorkspace.applySharedStoryToSelected).toHaveBeenCalledWith(["item-a"]);
  });

  it("shows one expanded card at a time on a phone, with Prev/Next", () => {
    setViewportWidth(390);
    const state = fixtureBatchState({
      items: {
        "item-a": itemWithOnePhoto("item-a", { fields: { title: "Blue mug" } }),
        "item-b": itemWithOnePhoto("item-b", { fields: { title: "Vase" } }),
      },
      itemOrder: ["item-a", "item-b"],
      photos: {
        "item-a-photo": makeBulkDraftPhoto("item-a-photo", { itemClientId: "item-a" }, 1000),
        "item-b-photo": makeBulkDraftPhoto("item-b-photo", { itemClientId: "item-b" }, 1000),
      },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    const { toJSON } = render(<BulkReview />);

    let json = JSON.stringify(toJSON());
    expect(json).toContain("Blue mug");
    expect(json).not.toContain("\"Vase\"");

    fireEvent.press(screen.getByLabelText("Next →"));
    json = JSON.stringify(toJSON());
    expect(json).not.toContain("\"Blue mug\"");
    expect(json).toContain("Vase");
  });

  it("removes an item via dissolveItem", () => {
    const state = fixtureBatchState({
      items: { "item-a": itemWithOnePhoto("item-a") },
      itemOrder: ["item-a"],
      photos: { "item-a-photo": makeBulkDraftPhoto("item-a-photo", { itemClientId: "item-a" }, 1000) },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkReview />);

    fireEvent.press(screen.getByLabelText("Remove item"));
    expect(mockWorkspace.dissolveItem).toHaveBeenCalledWith("item-a");
  });
});
