import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { makeBulkDraftItem, makeBulkDraftPhoto } from "@/features/bulk/batchStore";
import { pickImages } from "@/lib/images/pickImages";
import { makeWorkspaceFixture, fixtureBatchState } from "../../support/bulkWorkspaceFixture";
import BulkPhotos from "../../../app/bulk/[batchKey]/photos";

let mockWorkspace = makeWorkspaceFixture();

jest.mock("@/features/bulk/BulkWorkspaceContext", () => ({
  useBulkWorkspaceContext: () => mockWorkspace,
}));

jest.mock("@/lib/images/pickImages", () => ({ pickImages: jest.fn() }));
jest.mock("@/lib/images/useFileDrop", () => ({ useFileDrop: () => ({ isDraggingOver: false }) }));

function trayPhoto(clientPhotoId: string) {
  return makeBulkDraftPhoto(clientPhotoId, {}, 1000);
}

describe("bulk photos screen", () => {
  beforeEach(() => {
    mockWorkspace = makeWorkspaceFixture();
    jest.mocked(pickImages).mockReset();
  });

  it("renders the tray and lets the giver select photos", () => {
    const state = fixtureBatchState({
      photos: { "photo-a": trayPhoto("photo-a"), "photo-b": trayPhoto("photo-b") },
    });
    mockWorkspace = makeWorkspaceFixture({ state });

    render(<BulkPhotos />);
    expect(screen.getAllByLabelText("Select this photo")).toHaveLength(2);
  });

  it("shows both grouping choices, with the resulting item count, once photos are selected", () => {
    const state = fixtureBatchState({
      photos: { "photo-a": trayPhoto("photo-a"), "photo-b": trayPhoto("photo-b") },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkPhotos />);

    const checkboxes = screen.getAllByLabelText("Select this photo");
    fireEvent.press(checkboxes[0] as never);
    fireEvent.press(checkboxes[1] as never);

    expect(screen.getByLabelText("Group as one item (2 photos)")).toBeTruthy();
    expect(screen.getByLabelText("One item per photo (2 items)")).toBeTruthy();
  });

  it("groups the selected photos as one item on press", async () => {
    const state = fixtureBatchState({
      photos: { "photo-a": trayPhoto("photo-a"), "photo-b": trayPhoto("photo-b") },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkPhotos />);

    const checkboxes = screen.getAllByLabelText("Select this photo");
    fireEvent.press(checkboxes[0] as never);
    fireEvent.press(checkboxes[1] as never);
    fireEvent.press(screen.getByLabelText("Group as one item (2 photos)"));

    await waitFor(() => expect(mockWorkspace.groupAsOneItem).toHaveBeenCalledWith(["photo-a", "photo-b"]));
  });

  it("splits a grouped item back to the tray on Split", () => {
    const item = { ...makeBulkDraftItem("item-1", 1000), photoClientIds: ["photo-a"], fields: { title: "Blue mug" } };
    const state = fixtureBatchState({
      items: { "item-1": item },
      itemOrder: ["item-1"],
      photos: { "photo-a": { ...trayPhoto("photo-a"), itemClientId: "item-1" } },
    });
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkPhotos />);

    fireEvent.press(screen.getByLabelText("Split"));
    expect(mockWorkspace.dissolveItem).toHaveBeenCalledWith("item-1");
  });

  it("picks and adds photos through the picker", async () => {
    jest.mocked(pickImages).mockResolvedValue([new File(["a"], "a.jpg", { type: "image/jpeg" })]);
    mockWorkspace = makeWorkspaceFixture({ state: fixtureBatchState() });
    render(<BulkPhotos />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add photos"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockWorkspace.addPhotos).toHaveBeenCalledTimes(1));
    const [added] = jest.mocked(mockWorkspace.addPhotos).mock.calls[0]!;
    expect(added).toHaveLength(1);
  });

  it("warns, without refusing, on a photo that looks already added", async () => {
    jest
      .mocked(pickImages)
      .mockResolvedValueOnce([new File(["a"], "mug.jpg", { type: "image/jpeg" })])
      .mockResolvedValueOnce([new File(["a"], "mug.jpg", { type: "image/jpeg" })]);
    mockWorkspace = makeWorkspaceFixture({ state: fixtureBatchState() });
    const { toJSON } = render(<BulkPhotos />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add photos"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Add photos"));
      await Promise.resolve();
    });

    await waitFor(() => expect(mockWorkspace.addPhotos).toHaveBeenCalledTimes(2));
    // `getByText` doesn't reliably match react-native-web's react-test-renderer
    // output at these pinned library versions — see `test/ui/Button.test.tsx`'s
    // header comment for the same workaround.
    expect(JSON.stringify(toJSON())).toContain("already added");
  });

  it("always prompts for a file when retrying a failed tray photo", async () => {
    const state = fixtureBatchState({
      photos: {
        "photo-a": { ...trayPhoto("photo-a"), status: "retryable_failure", canRetry: true, needsReselection: false, hasLocalSource: true },
      },
    });
    jest.mocked(pickImages).mockResolvedValue([new File(["a"], "retry.jpg", { type: "image/jpeg" })]);
    mockWorkspace = makeWorkspaceFixture({ state });
    render(<BulkPhotos />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Try again"));
      await Promise.resolve();
    });

    expect(pickImages).toHaveBeenCalledWith({ multiple: false });
    expect(mockWorkspace.retryPhoto).toHaveBeenCalledWith("photo-a", expect.any(File));
  });
});
