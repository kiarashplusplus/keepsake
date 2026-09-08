import * as React from "react";
import { render, screen } from "@testing-library/react-native";
import { makeWorkspaceFixture } from "../../support/bulkWorkspaceFixture";
import BulkBatchLayout from "../../../app/bulk/[batchKey]/_layout";

let mockWorkspace = makeWorkspaceFixture();

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ batchKey: "batch-1" }),
    usePathname: () => "/bulk/batch-1/photos",
    Stack: () => null,
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/features/bulk/BulkWorkspaceContext", () => ({
  BulkWorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
  useBulkWorkspaceContext: () => mockWorkspace,
}));

describe("bulk/[batchKey]/_layout", () => {
  it("shows a not-found state honestly, with no error banner, when this device holds nothing for the batch", () => {
    mockWorkspace = makeWorkspaceFixture({ status: "not_found" });
    render(<BulkBatchLayout />);
    expect(JSON.stringify(screen.toJSON())).toContain("isn't on this device");
  });

  it("shows an honest unavailable state, not a broken-looking spinner, when the feature is off", () => {
    mockWorkspace = makeWorkspaceFixture({ status: "unavailable" });
    render(<BulkBatchLayout />);
    expect(JSON.stringify(screen.toJSON())).toContain("Not open on this build yet");
  });

  it("renders the batch name and tabs once ready", () => {
    mockWorkspace = makeWorkspaceFixture({ status: "ready" });
    render(<BulkBatchLayout />);
    const json = JSON.stringify(screen.toJSON());
    expect(json).toContain("Mum's house");
    expect(json).toContain("Photos");
    expect(json).toContain("Review");
    expect(json).toContain("Submit");
  });

  it("surfaces the upload-pause banner while the queue is paused", () => {
    mockWorkspace = makeWorkspaceFixture({ status: "ready", uploadPausedUntil: Date.now() + 60_000 });
    render(<BulkBatchLayout />);
    expect(JSON.stringify(screen.toJSON())).toContain("Pausing uploads");
  });
});
