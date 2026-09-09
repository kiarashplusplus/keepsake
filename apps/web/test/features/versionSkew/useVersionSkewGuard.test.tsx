import * as React from "react";
import { Pressable, Text } from "react-native";
import { act, render } from "@testing-library/react-native";
import { useVersionSkewGuard } from "@/features/versionSkew/useVersionSkewGuard";
import { POLL_INTERVAL_MS, MIN_FOCUS_POLL_GAP_MS } from "@/lib/versionSkew";

const MATCHING_FULL_SHA = "a1b2c3d4e5f6789012345678901234567890abcd"; // starts with "a1b2c3d"
const OTHER_FULL_SHA = "9999999deadbeef0000000000000000deadbeef";

type FakeResponse = { ok: boolean; headers: { get: (name: string) => string | null }; json: () => Promise<unknown> };

function fakeResponse(commit: string, cacheControl: string | null = "no-store"): FakeResponse {
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === "cache-control" ? cacheControl : null) },
    json: async () => ({ commit }),
  };
}

function Probe({ buildCommit }: { buildCommit: string }): React.ReactElement {
  const { stale, latestCommit, dismiss, reload } = useVersionSkewGuard({ buildCommit });
  return (
    <>
      <Text>{stale ? "STALE" : "FRESH"}</Text>
      <Text>{latestCommit ?? "none"}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="dismiss" onPress={dismiss}>
        <Text>dismiss</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="reload" onPress={reload}>
        <Text>reload</Text>
      </Pressable>
    </>
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    // Deliberately drain microtasks sequentially.
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("useVersionSkewGuard", () => {
  let fetchMock: jest.Mock;
  let reloadMock: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    reloadMock = jest.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadMock },
      writable: true,
      configurable: true,
    });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("does NOT go stale when /version.json's commit matches the build's short commit", async () => {
    fetchMock.mockResolvedValue(fakeResponse(MATCHING_FULL_SHA));
    const { toJSON } = render(<Probe buildCommit="a1b2c3d" />);
    await flush();

    expect(JSON.stringify(toJSON())).toContain("FRESH");
    expect(JSON.stringify(toJSON())).not.toContain("STALE");
  });

  it("goes stale when /version.json's commit does not match the build's short commit", async () => {
    fetchMock.mockResolvedValue(fakeResponse(OTHER_FULL_SHA));
    const { toJSON, UNSAFE_getByProps } = render(<Probe buildCommit="a1b2c3d" />);
    await flush();

    expect(JSON.stringify(toJSON())).toContain("STALE");

    // Reload is only ever fired by the visitor pressing the button — proof
    // the hook itself never calls `location.reload()` unprompted.
    expect(reloadMock).not.toHaveBeenCalled();
    const reloadButton = UNSAFE_getByProps({ accessibilityLabel: "reload" });
    act(() => {
      reloadButton.props.onPress();
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("dismiss hides the banner for that commit but a later, different commit re-shows it", async () => {
    fetchMock.mockResolvedValue(fakeResponse(OTHER_FULL_SHA));
    jest.useFakeTimers();
    const { toJSON, UNSAFE_getByProps } = render(<Probe buildCommit="a1b2c3d" />);
    await flush();
    expect(JSON.stringify(toJSON())).toContain("STALE");

    act(() => {
      UNSAFE_getByProps({ accessibilityLabel: "dismiss" }).props.onPress();
    });
    expect(JSON.stringify(toJSON())).toContain("FRESH");

    // A further deploy — the interval's next poll sees yet another commit.
    const EVEN_NEWER_SHA = "1111111abcdefabcdefabcdefabcdefabcdefab";
    fetchMock.mockResolvedValue(fakeResponse(EVEN_NEWER_SHA));
    act(() => {
      jest.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    await flush();

    expect(JSON.stringify(toJSON())).toContain("STALE");
  });

  it("polls on an interval, not before it elapses", async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(fakeResponse(MATCHING_FULL_SHA));
    render(<Probe buildCommit="a1b2c3d" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(POLL_INTERVAL_MS - 1);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-checks on window focus, but not again within the minimum gap", async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(fakeResponse(MATCHING_FULL_SHA));
    render(<Probe buildCommit="a1b2c3d" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Immediately refocusing (e.g. rapid tab switching) must not be chatty.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(MIN_FOCUS_POLL_GAP_MS);
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("warns once when /version.json is served WITHOUT Cache-Control: no-store — the guard can fail loudly, not silently", async () => {
    // This is the failure mode this repo keeps shipping: a poll against an
    // endpoint the browser/CDN is allowed to cache never sees a change.
    // `responseIsCacheable` (versionSkew.ts) is what notices it here.
    fetchMock.mockResolvedValue(fakeResponse(MATCHING_FULL_SHA, "public, max-age=60"));
    render(<Probe buildCommit="a1b2c3d" />);
    await flush();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Cache-Control: no-store");
  });
});
