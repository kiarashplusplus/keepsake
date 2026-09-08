import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { makeBulkDraftItem } from "@/features/bulk/batchStore";
import { makeWorkspaceFixture, fixtureBatchState } from "../../support/bulkWorkspaceFixture";
import BulkSubmit from "../../../app/bulk/[batchKey]/submit";

let mockWorkspace = makeWorkspaceFixture();

jest.mock("@/features/bulk/BulkWorkspaceContext", () => ({
  useBulkWorkspaceContext: () => mockWorkspace,
}));

function readyItem(clientItemId: string, revision = 3) {
  return { ...makeBulkDraftItem(clientItemId, 1000), fields: { title: `Item ${clientItemId}` }, ready: true, revision, photoClientIds: [`${clientItemId}-photo`] };
}

describe("bulk submit screen", () => {
  beforeEach(() => {
    mockWorkspace = makeWorkspaceFixture();
  });

  it("prompts to finish details when nothing is ready", () => {
    mockWorkspace = makeWorkspaceFixture({ state: fixtureBatchState() });
    const { toJSON } = render(<BulkSubmit />);
    expect(JSON.stringify(toJSON())).toContain("Nothing is ready yet");
  });

  it("pre-selects every ready item and submits the selected ones with a date of birth", async () => {
    const state = fixtureBatchState({
      items: { "item-a": readyItem("item-a"), "item-b": readyItem("item-b") },
      itemOrder: ["item-a", "item-b"],
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkSubmit />);

    expect(screen.getByLabelText("Submit 2 items")).toBeTruthy();

    fireEvent.changeText(screen.getByLabelText("Date of birth"), "1990-01-01");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Submit 2 items"));
      await Promise.resolve();
    });

    expect(mockWorkspace.submitItems).toHaveBeenCalledWith(["item-a", "item-b"], "1990-01-01");
  });

  it("refuses to submit without a valid date of birth", async () => {
    const state = fixtureBatchState({ items: { "item-a": readyItem("item-a") }, itemOrder: ["item-a"] });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkSubmit />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Submit 1 item"));
      await Promise.resolve();
    });

    expect(mockWorkspace.submitItems).not.toHaveBeenCalled();
  });

  it("lets the giver deselect an item before submitting", async () => {
    const state = fixtureBatchState({
      items: { "item-a": readyItem("item-a"), "item-b": readyItem("item-b") },
      itemOrder: ["item-a", "item-b"],
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkSubmit />);

    fireEvent.press(screen.getByLabelText("Select none"));
    fireEvent.changeText(screen.getByLabelText("Date of birth"), "1990-01-01");
    // Button label reflects the empty selection...
    expect(screen.getByLabelText("Submit 0 items")).toBeTruthy();
  });

  it("shows separate saved/pending/failed counts", () => {
    const state = fixtureBatchState({
      items: {
        "item-a": { ...readyItem("item-a"), state: "submitted", listingId: "01LISTINGA0000000000000000" },
        "item-b": { ...readyItem("item-b"), state: "queued" },
        "item-c": { ...makeBulkDraftItem("item-c", 1000), state: "failed" },
        "item-d": { ...makeBulkDraftItem("item-d", 1000), state: "editing" },
      },
      itemOrder: ["item-a", "item-b", "item-c", "item-d"],
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    const { toJSON } = render(<BulkSubmit />);
    // Each `{count} label` pair renders as two separate text children under
    // react-native-web, so `JSON.stringify` never puts "1 saved draft" back
    // together as one contiguous substring — asserting on each half instead.
    const json = JSON.stringify(toJSON());
    expect(json).toContain("saved draft");
    expect(json).toContain("submitted/pending");
    expect(json).toContain("live or moved on");
    expect(json).toContain("failed");
    expect((json.match(/"1"/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
