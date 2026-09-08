import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { createBatch } from "@/api/bulk";
import { lookupPostalCode } from "@/api/geo";
import { getStoredGrantId } from "@/lib/bulkGrant";
import NewBulkBatch from "../../../app/bulk/new";

const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

jest.mock("@/api/bulk", () => ({ createBatch: jest.fn() }));
jest.mock("@/api/geo", () => ({ lookupPostalCode: jest.fn() }));

describe("bulk/new", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.useFakeTimers();
    mockReplace.mockReset();
    jest.mocked(createBatch).mockReset();
    jest.mocked(lookupPostalCode).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("never calls createBatch before a postcode has resolved, even with every other field filled in", async () => {
    // Deliberately never resolves — the postcode lookup effect is still
    // debouncing/in flight the whole test.
    jest.mocked(lookupPostalCode).mockReturnValue(new Promise(() => {}));
    render(<NewBulkBatch />);

    fireEvent.changeText(screen.getByLabelText("Batch name"), "Mum's house");
    fireEvent.changeText(screen.getByLabelText("Admission code"), "grant-abc");
    fireEvent.changeText(screen.getByLabelText("Postcode"), "02144");

    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Start this batch"));
      await Promise.resolve();
    });

    expect(createBatch).not.toHaveBeenCalled();
  });

  it("creates the batch, saves it locally, and navigates to its photos step", async () => {
    jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
    jest.mocked(createBatch).mockResolvedValue({
      ok: true,
      data: {
        id: "01BATCHA000000000000000000",
        client_batch_key: "unused-because-caller-mints-it",
        name: "Mum's house",
        country: "US",
        postal_code: "02144",
        place_name: "Somerville",
        admin1: "MA",
        shared_story: null,
        state: "draft",
        revision: 1,
        item_count: 0,
        ready_count: 0,
        photo_count: 0,
        created_at: 1,
        updated_at: 1,
        expires_at: 999999,
      },
    });
    render(<NewBulkBatch />);

    fireEvent.changeText(screen.getByLabelText("Batch name"), "Mum's house");
    fireEvent.changeText(screen.getByLabelText("Admission code"), "grant-abc");
    fireEvent.changeText(screen.getByLabelText("Postcode"), "02144");
    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Start this batch"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createBatch).toHaveBeenCalledWith(expect.objectContaining({ name: "Mum's house", country: "US", postal_code: "02144" }), { grantId: "grant-abc" });
    expect(mockReplace).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/bulk/[batchKey]/photos" }));
    expect(getStoredGrantId()).toBe("grant-abc");
  });

  it("shows the API's own error message on a failed create, and does not navigate", async () => {
    jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
    jest.mocked(createBatch).mockResolvedValue({ ok: false, error: { kind: "no_grant", message: "That admission grant isn't usable." } });
    render(<NewBulkBatch />);

    fireEvent.changeText(screen.getByLabelText("Batch name"), "Mum's house");
    fireEvent.changeText(screen.getByLabelText("Admission code"), "expired-grant");
    fireEvent.changeText(screen.getByLabelText("Postcode"), "02144");
    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Start this batch"));
      await Promise.resolve();
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.toJSON())).toContain("isn't usable");
  });
});
