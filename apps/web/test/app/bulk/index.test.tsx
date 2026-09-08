import * as React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { ApiError } from "@/api/client";
import { listBatches } from "@/api/bulk";
import { getOwnerToken } from "@/lib/ownerToken";
import BulkBatchList from "../../../app/bulk/index";

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/bulk", () => ({ listBatches: jest.fn() }));
jest.mock("@/lib/ownerToken", () => ({ getOwnerToken: jest.fn() }));

describe("bulk/index (batch list)", () => {
  beforeEach(() => {
    jest.mocked(listBatches).mockReset();
    jest.mocked(getOwnerToken).mockReset();
  });

  it("degrades honestly, rather than looking broken, when the API 404s the whole feature", async () => {
    jest.mocked(getOwnerToken).mockReturnValue("ks_test");
    jest.mocked(listBatches).mockRejectedValue(new ApiError("not_found", "Not found.", 404));

    render(<BulkBatchList />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(JSON.stringify(screen.toJSON())).toContain("Not open on this build yet");
  });

  it("lists every batch with its item/photo counts, and a Continue link", async () => {
    jest.mocked(getOwnerToken).mockReturnValue("ks_test");
    jest.mocked(listBatches).mockResolvedValue([
      {
        id: "01BATCHA000000000000000000",
        client_batch_key: "batch-1",
        name: "Mum's house",
        country: "US",
        postal_code: "94110",
        place_name: "San Francisco",
        admin1: "CA",
        shared_story: null,
        state: "draft",
        revision: 1,
        item_count: 5,
        ready_count: 2,
        photo_count: 12,
        created_at: 1000,
        updated_at: 2000,
        expires_at: 999999999999,
      },
    ]);

    render(<BulkBatchList />);
    await act(async () => {
      await Promise.resolve();
    });

    const json = JSON.stringify(screen.toJSON());
    expect(json).toContain("Mum's house");
    expect(json).toContain("Continue preparing");
  });

  it("offers Start a new batch even before any owner token exists", () => {
    jest.mocked(getOwnerToken).mockReturnValue(null);
    render(<BulkBatchList />);
    expect(screen.getByLabelText("Start a new batch")).toBeTruthy();
    expect(listBatches).not.toHaveBeenCalled();
  });
});
