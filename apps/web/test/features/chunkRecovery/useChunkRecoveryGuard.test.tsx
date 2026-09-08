import * as React from "react";
import { Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { useChunkRecoveryGuard } from "@/features/chunkRecovery/useChunkRecoveryGuard";
import { CHUNK_RECOVERY_RELOAD_FLAG } from "@/lib/chunkRecovery";

function Probe(): React.ReactElement {
  useChunkRecoveryGuard();
  return <Text>mounted</Text>;
}

function dispatchRejection(reason: unknown): void {
  const event = new Event("unhandledrejection") as Event & { reason?: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
}

/** The channel that actually fires for expo-router's `React.lazy`-wrapped
 * routes — see `useChunkRecoveryGuard.ts`'s header comment: React attaches
 * its own rejection handler to the lazy import's promise, so the failure
 * resurfaces as a plain synchronous `error` event on a later render, not an
 * `unhandledrejection`. */
function dispatchSyntheticError(error: unknown, filename?: string): void {
  const event = new Event("error") as Event & { error?: unknown; message?: string; filename?: string };
  event.error = error;
  if (filename !== undefined) event.filename = filename;
  window.dispatchEvent(event);
}

describe("useChunkRecoveryGuard", () => {
  let reloadMock: jest.Mock;

  beforeEach(() => {
    window.sessionStorage.clear();
    reloadMock = jest.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadMock },
      writable: true,
      configurable: true,
    });
  });

  it("reloads once when an unhandledrejection looks like a failed chunk import", () => {
    render(<Probe />);
    act(() => {
      dispatchRejection(new Error("Failed to fetch dynamically imported module: /_expo/static/js/web/give-abc123.js"));
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RECOVERY_RELOAD_FLAG)).toBe("1");
  });

  it("does NOT reload for an unrelated rejection", () => {
    render(<Probe />);
    act(() => {
      dispatchRejection(new Error("listing not found"));
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("does not loop: a second chunk-load rejection in the same tab does not reload again", () => {
    render(<Probe />);
    act(() => {
      dispatchRejection(new Error("Failed to fetch dynamically imported module: /_expo/static/js/web/give-abc123.js"));
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchRejection(new Error("Failed to fetch dynamically imported module: /_expo/static/js/web/mine-def456.js"));
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("honors a flag already set by a previous mount in the same tab (e.g. StrictMode remount)", () => {
    window.sessionStorage.setItem(CHUNK_RECOVERY_RELOAD_FLAG, "1");
    render(<Probe />);
    act(() => {
      dispatchRejection(new Error("Failed to fetch dynamically imported module: /_expo/static/js/web/give-abc123.js"));
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloads once when the failure surfaces as a synchronous `error` event, not a rejection — the real path for a lazy route", () => {
    render(<Probe />);
    act(() => {
      dispatchSyntheticError(new Error("Loading module https://x/_expo/static/js/web/give-abc123.js failed."));
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RECOVERY_RELOAD_FLAG)).toBe("1");
  });

  it("does NOT reload for an unrelated synchronous error", () => {
    render(<Probe />);
    act(() => {
      dispatchSyntheticError(new Error("Cannot read properties of undefined (reading 'foo')"));
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
