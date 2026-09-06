import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ReportSheet } from "@/features/report/ReportSheet";
import { createReport } from "@/api/reports";
import { ApiError } from "@/api/client";

jest.mock("@/api/reports", () => ({ createReport: jest.fn() }));

// See test/app/item/[id].test.tsx's header comment.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
  };
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

describe("ReportSheet", () => {
  beforeEach(() => {
    jest.mocked(createReport).mockReset();
  });

  it("submits the selected reason and shows the thanks state on success", async () => {
    jest.mocked(createReport).mockResolvedValue({ id: "report-1" });
    const instance = render(<ReportSheet visible onClose={jest.fn()} listingId="listing-1" />);

    const spamReason = instance.UNSAFE_getByProps({ accessibilityLabel: "Spam" });
    await act(async () => {
      fireEvent.press(spamReason);
      await flush();
    });

    const submitButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Submit" });
    await act(async () => {
      fireEvent.press(submitButton);
      await flush();
    });

    expect(jest.mocked(createReport)).toHaveBeenCalledWith("listing-1", { reason: "spam" }, expect.objectContaining({ turnstileToken: "" }));
    expect(JSON.stringify(instance.toJSON())).toContain("Thanks. We'll take a look.");
  });

  it("shows the 409 conflict message inline", async () => {
    jest.mocked(createReport).mockRejectedValue(new ApiError("conflict", "Already reported", 409));
    const instance = render(<ReportSheet visible onClose={jest.fn()} listingId="listing-1" />);

    const reason = instance.UNSAFE_getByProps({ accessibilityLabel: "Not a keepsake" });
    await act(async () => {
      fireEvent.press(reason);
      await flush();
    });

    const submitButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Submit" });
    await act(async () => {
      fireEvent.press(submitButton);
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("You've already reported this.");
  });
});
