import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { unsubscribeStatus, confirmUnsubscribe, confirmResubscribe } from "@/api/unsubscribe";
import UnsubscribeToken from "../../../app/unsubscribe/[token]";

// Same `Link` mock shape as test/app/withdraw/[token].test.tsx.
jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ token: "unsub-token-abc" }),
    Link: ({ children, asChild, href }: { children: React.ReactNode; asChild?: boolean; href?: string }) =>
      asChild && ReactActual.isValidElement(children)
        ? ReactActual.cloneElement(children as React.ReactElement, { href })
        : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/unsubscribe", () => ({
  unsubscribeStatus: jest.fn(),
  confirmUnsubscribe: jest.fn(),
  confirmResubscribe: jest.fn(),
}));

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("unsubscribe/[token]", () => {
  beforeEach(() => {
    jest.mocked(unsubscribeStatus).mockReset();
    jest.mocked(confirmUnsubscribe).mockReset();
    jest.mocked(confirmResubscribe).mockReset();
  });

  it("never POSTs on mount — GET status only, and shows the consequence before any button exists", async () => {
    jest.mocked(unsubscribeStatus).mockResolvedValue({ unsubscribed: false });

    const utils = render(
      <ToastProvider>
        <UnsubscribeToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(jest.mocked(unsubscribeStatus)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(unsubscribeStatus)).toHaveBeenCalledWith("unsub-token-abc");
    expect(jest.mocked(confirmUnsubscribe)).not.toHaveBeenCalled();

    const tree = JSON.stringify(utils.toJSON());
    // The consequence, stated before a click is possible.
    expect(tree).toContain("Stop these emails?");
    expect(tree).toContain("still show up on your dashboard");
    expect(tree).toContain("Stop these emails");
  });

  it("only calls the API to unsubscribe after the button is pressed", async () => {
    jest.mocked(unsubscribeStatus).mockResolvedValue({ unsubscribed: false });
    jest.mocked(confirmUnsubscribe).mockResolvedValue({ unsubscribed: true });

    const utils = render(
      <ToastProvider>
        <UnsubscribeToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    await act(async () => {
      fireEvent.press(utils.getByLabelText("Stop these emails"));
      await flush();
    });

    expect(jest.mocked(confirmUnsubscribe)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(confirmUnsubscribe)).toHaveBeenCalledWith("unsub-token-abc");

    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("You're unsubscribed.");
    // The way back stays visible on the confirmation screen.
    expect(tree).toContain("same link any time");
  });

  it("an already-unsubscribed token offers resubscribe, and states what's currently off", async () => {
    jest.mocked(unsubscribeStatus).mockResolvedValue({ unsubscribed: true });

    const utils = render(
      <ToastProvider>
        <UnsubscribeToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("You're currently unsubscribed");
    expect(tree).toContain("Start receiving these again");
  });

  it("resubscribing calls the API and confirms", async () => {
    jest.mocked(unsubscribeStatus).mockResolvedValue({ unsubscribed: true });
    jest.mocked(confirmResubscribe).mockResolvedValue({ unsubscribed: false });

    const utils = render(
      <ToastProvider>
        <UnsubscribeToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    await act(async () => {
      fireEvent.press(utils.getByLabelText("Start receiving these again"));
      await flush();
    });

    expect(jest.mocked(confirmResubscribe)).toHaveBeenCalledWith("unsub-token-abc");
    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("You're back on the list.");
  });

  it("a status fetch failure shows a generic error, not a stuck spinner", async () => {
    jest.mocked(unsubscribeStatus).mockRejectedValue(new TypeError("Failed to fetch"));

    const utils = render(
      <ToastProvider>
        <UnsubscribeToken />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    const tree = JSON.stringify(utils.toJSON());
    expect(tree).toContain("That link didn't work");
    expect(tree).not.toContain("One moment");
  });
});
