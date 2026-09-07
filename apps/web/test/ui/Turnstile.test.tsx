import * as React from "react";
import { render, waitFor } from "@testing-library/react-native";
import { ThemeProvider } from "@/ui/theme";
import { Turnstile, type TurnstileHandle, type TurnstileStatus } from "@/ui/Turnstile";
// `jest.mock` below hoists above this import (babel-plugin-jest-hoist), so
// this binds to the *mocked* module — the same object instance
// `Turnstile.web.tsx` itself reads `config.turnstileSiteKey` off of.
// Mutating it between tests toggles "configured" vs "unconfigured" without
// needing to re-evaluate the module. Referencing an outer `mockConfig`
// variable from inside the factory itself would hit the TDZ (the factory
// runs, via the hoisted `require`, before that `const` has been assigned).
import { config as mockConfig } from "@/lib/config";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

jest.mock("@/lib/config", () => ({ config: { turnstileSiteKey: "" } }));

type RenderOptions = {
  sitekey: string;
  theme: "light" | "dark";
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};

type TurnstileApi = {
  render: jest.Mock<string, [HTMLElement, RenderOptions]>;
  remove: jest.Mock;
  reset: jest.Mock;
};

function installFakeTurnstile(): TurnstileApi {
  const api: TurnstileApi = { render: jest.fn<string, [HTMLElement, RenderOptions]>(() => "widget-1"), remove: jest.fn(), reset: jest.fn() };
  (window as unknown as { turnstile?: TurnstileApi }).turnstile = api;
  return api;
}

function clearGlobalTurnstileState(): void {
  delete (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  document.querySelectorAll(`script[src="${SCRIPT_SRC}"]`).forEach((node) => node.remove());
}

function renderTurnstile(onStatus: (status: TurnstileStatus) => void, ref?: React.Ref<TurnstileHandle>) {
  return render(
    <ThemeProvider mode="light">
      <Turnstile ref={ref} onStatus={onStatus} />
    </ThemeProvider>,
    // `@testing-library/react-native` always renders through
    // `react-test-renderer`, even under the "web" jest preset — there is no
    // real DOM, so the component's own `containerRef.current` (cast to
    // `HTMLElement` for the real browser) would otherwise be null and the
    // component would report `{status:"unconfigured"}` before ever reaching
    // `window.turnstile.render`. `createNodeMock` stands in for the real
    // element react-test-renderer can't produce.
    { createNodeMock: () => ({}) },
  );
}

describe("Turnstile (jest-expo/web resolves the .web.tsx implementation)", () => {
  beforeEach(() => {
    clearGlobalTurnstileState();
    mockConfig.turnstileSiteKey = "";
  });

  afterEach(() => {
    clearGlobalTurnstileState();
  });

  it("reports unconfigured immediately when no site key is configured, so the flow still works on preview", () => {
    const onStatus = jest.fn();
    renderTurnstile(onStatus);

    expect(onStatus).toHaveBeenCalledWith({ status: "unconfigured" });
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("renders the widget once the script loads and reports ready on the widget's callback", async () => {
    mockConfig.turnstileSiteKey = "1x00000000000000000000AA";
    const api = installFakeTurnstile();
    const onStatus = jest.fn();
    renderTurnstile(onStatus);

    expect(onStatus).toHaveBeenCalledWith({ status: "pending" });
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    const options = api.render.mock.calls[0]?.[1] as RenderOptions;
    options.callback("a-real-token");
    expect(onStatus).toHaveBeenCalledWith({ status: "ready", token: "a-real-token" });
  });

  it("GUARD: clears a ready token on expiry and resets the widget for a fresh one", async () => {
    mockConfig.turnstileSiteKey = "1x00000000000000000000AA";
    const api = installFakeTurnstile();
    const onStatus = jest.fn();
    renderTurnstile(onStatus);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    const options = api.render.mock.calls[0]?.[1] as RenderOptions;
    options.callback("a-real-token");
    options["expired-callback"]();

    // The whole point: a caller deriving `canSubmit` from the *latest*
    // status must see the token gone, not the stale `ready` value from
    // before expiry.
    expect(onStatus).toHaveBeenLastCalledWith({ status: "expired" });
    expect(api.reset).toHaveBeenCalledWith("widget-1");
  });

  // Issue #174. This case used to assert the opposite — that a widget error
  // left submit disabled — which is exactly the dead end it describes: five
  // call sites compute `turnstileReady = status === "ready" || status ===
  // "unconfigured"` and pass it to `disabled`, nothing anywhere renders copy
  // for a failed challenge, and the error branch never reset the widget, so
  // it could not self-heal. A challenge failure now answers the same way a
  // blocked script already did: `unconfigured`, and the API's `siteverify`
  // makes the real decision server-side.
  it("GUARD: a widget-level error does not dead-end submit — it reports unconfigured, like a blocked script", async () => {
    mockConfig.turnstileSiteKey = "1x00000000000000000000AA";
    const api = installFakeTurnstile();
    const onStatus = jest.fn();
    renderTurnstile(onStatus);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    const options = api.render.mock.calls[0]?.[1] as RenderOptions;
    options["error-callback"]();

    expect(onStatus).toHaveBeenLastCalledWith({ status: "unconfigured" });
    // Computed exactly the way all five consumers compute it.
    const last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0] as TurnstileStatus;
    const submitEnabled = last.status === "ready" || last.status === "unconfigured";
    expect(submitEnabled).toBe(true);
  });

  it("GUARD: does not reset the widget from the error path, which would be an unbounded retry loop on a permanent 110200", async () => {
    mockConfig.turnstileSiteKey = "1x00000000000000000000AA";
    const api = installFakeTurnstile();
    const onStatus = jest.fn();
    renderTurnstile(onStatus);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    const options = api.render.mock.calls[0]?.[1] as RenderOptions;
    options["error-callback"]();
    options["error-callback"]();

    expect(api.reset).not.toHaveBeenCalled();
  });

  it("GUARD: a late widget error does not throw away a token the giver can still spend", async () => {
    mockConfig.turnstileSiteKey = "1x00000000000000000000AA";
    const api = installFakeTurnstile();
    const onStatus = jest.fn();
    renderTurnstile(onStatus);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    const options = api.render.mock.calls[0]?.[1] as RenderOptions;
    options.callback("a-real-token");
    // A failed *refresh* after a good challenge. Downgrading to
    // `unconfigured` here would submit an empty `cf-turnstile-response` and
    // earn a `turnstile_failed` the giver did nothing to deserve.
    options["error-callback"]();

    expect(onStatus).toHaveBeenLastCalledWith({ status: "ready", token: "a-real-token" });

    // Expiry still retires it, and after that an error is free to report
    // `unconfigured` again.
    options["expired-callback"]();
    options["error-callback"]();
    expect(onStatus).toHaveBeenLastCalledWith({ status: "unconfigured" });
  });

  it("exposes a reset handle that resets the underlying widget", async () => {
    mockConfig.turnstileSiteKey = "1x00000000000000000000AA";
    const api = installFakeTurnstile();
    const onStatus = jest.fn();
    const ref = React.createRef<TurnstileHandle>();
    renderTurnstile(onStatus, ref);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    ref.current?.reset();
    expect(api.reset).toHaveBeenCalledWith("widget-1");
  });

  it("GUARD: does not let one failed script load poison a later mount's retry in the same tab", async () => {
    mockConfig.turnstileSiteKey = "1x00000000000000000000AA";
    // No fake `window.turnstile` installed yet: the script tag itself will
    // be made to fail below, simulating an ad blocker or a blocked CDN.
    const onStatusA = jest.fn();
    const first = renderTurnstile(onStatusA);

    const firstScript = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    expect(firstScript).not.toBeNull();
    firstScript?.dispatchEvent(new Event("error"));

    // The design choice from the give-flow plan: a blocked script should
    // let the giver proceed rather than dead-end them — `unconfigured`,
    // not `error`.
    await waitFor(() => expect(onStatusA).toHaveBeenCalledWith({ status: "unconfigured" }));
    first.unmount();

    // A second mount, after the first's script load failed, must actually
    // retry — a fresh `<script>` tag, not a permanently-rejected promise
    // returned from the module-level cache (the bug: `scriptPromise` was
    // never cleared on rejection, so every later mount inherited the same
    // dead promise and never tried loading the script again, even after
    // whatever blocked it stopped blocking it).
    const onStatusB = jest.fn();
    renderTurnstile(onStatusB);

    const scriptsAfterSecondMount = document.querySelectorAll<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    expect(scriptsAfterSecondMount).toHaveLength(1);
    const secondScript = scriptsAfterSecondMount[0];
    expect(secondScript).not.toBe(firstScript);

    // Mimic the ad blocker being disabled / the CDN recovering: this time
    // the (fresh) script actually loads.
    const api = installFakeTurnstile();
    secondScript?.dispatchEvent(new Event("load"));

    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
  });
});
