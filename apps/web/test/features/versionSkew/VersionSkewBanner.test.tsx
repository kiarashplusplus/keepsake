import * as React from "react";
import { render, act } from "@testing-library/react-native";
import { ThemeProvider } from "@/ui/theme";
import { VersionSkewBanner } from "@/features/versionSkew/VersionSkewBanner";
import type { VersionSkewGuardState } from "@/features/versionSkew/useVersionSkewGuard";

// The banner also mounts its own `useVersionSkewGuard()` internally (the
// `state` prop below only overrides what gets *rendered*, matching how
// `app/_layout.tsx` really uses it). Stubbed `fetch` never resolves: these
// tests assert on the injected `state`, not on a real poll outcome, and a
// resolved promise would call `setLatestCommit` after the test has already
// finished asserting — an `act()` warning for a state update this test
// doesn't care about.
beforeEach(() => {
  (globalThis as { fetch?: typeof fetch }).fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
});

function stateFixture(overrides: Partial<VersionSkewGuardState> = {}): VersionSkewGuardState {
  return {
    stale: false,
    latestCommit: null,
    dismiss: jest.fn(),
    reload: jest.fn(),
    ...overrides,
  };
}

describe("VersionSkewBanner", () => {
  it("renders nothing when the guard reports fresh", () => {
    const { toJSON } = render(
      <ThemeProvider mode="light">
        <VersionSkewBanner state={stateFixture({ stale: false })} />
      </ThemeProvider>,
    );
    expect(toJSON()).toBeNull();
  });

  it("renders the reload affordance, with wording that never demands anything, when the guard reports stale", () => {
    const { toJSON } = render(
      <ThemeProvider mode="light">
        <VersionSkewBanner state={stateFixture({ stale: true, latestCommit: "abc1234" })} />
      </ThemeProvider>,
    );
    const tree = JSON.stringify(toJSON());
    expect(tree).toContain("new version");
    expect(tree).toContain("Reload");
    expect(tree).toContain("Dismiss");
  });

  it("wires the Reload button to the guard's reload(), and Dismiss to dismiss() — never calling either on its own", () => {
    const reload = jest.fn();
    const dismiss = jest.fn();
    const { UNSAFE_getByProps } = render(
      <ThemeProvider mode="light">
        <VersionSkewBanner state={stateFixture({ stale: true, reload, dismiss })} />
      </ThemeProvider>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();

    act(() => {
      UNSAFE_getByProps({ accessibilityLabel: "Reload" }).props.onPress();
    });
    expect(reload).toHaveBeenCalledTimes(1);

    act(() => {
      UNSAFE_getByProps({ accessibilityLabel: "Dismiss" }).props.onPress();
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
