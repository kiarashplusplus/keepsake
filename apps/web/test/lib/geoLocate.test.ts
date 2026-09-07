import { locateOnce } from "@/lib/geoLocate";

type MockNavigator = {
  geolocation: {
    getCurrentPosition: jest.Mock;
  };
};

function installGeolocation(): MockNavigator["geolocation"]["getCurrentPosition"] {
  const getCurrentPosition = jest.fn();
  Object.defineProperty(globalThis, "navigator", {
    value: { geolocation: { getCurrentPosition } },
    configurable: true,
  });
  return getCurrentPosition;
}

describe("locateOnce", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("reports coordinates from a successful position", () => {
    const getCurrentPosition = installGeolocation();
    const onSuccess = jest.fn();
    const onError = jest.fn();

    locateOnce(onSuccess, onError);

    const [successCb] = getCurrentPosition.mock.calls[0] as [(position: GeolocationPosition) => void];
    successCb({ coords: { latitude: 42.39, longitude: -71.1 } } as GeolocationPosition);

    expect(onSuccess).toHaveBeenCalledWith({ lat: 42.39, lng: -71.1 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports an error message on a permission-denied failure, and ignores a late success", () => {
    const getCurrentPosition = installGeolocation();
    const onSuccess = jest.fn();
    const onError = jest.fn();

    locateOnce(onSuccess, onError);

    const [successCb, errorCb] = getCurrentPosition.mock.calls[0] as [
      (position: GeolocationPosition) => void,
      (error: GeolocationPositionError) => void,
    ];
    errorCb({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    // The `settled` guard: a callback firing after the outcome is already
    // decided must be a no-op, not a second (possibly conflicting) result.
    successCb({ coords: { latitude: 1, longitude: 1 } } as GeolocationPosition);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("falls back to the watchdog when neither callback ever fires", () => {
    jest.useFakeTimers();
    installGeolocation(); // getCurrentPosition never invokes either callback.
    const onSuccess = jest.fn();
    const onError = jest.fn();

    locateOnce(onSuccess, onError);
    jest.advanceTimersByTime(15_000);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("reports unavailable when the browser has no geolocation object", () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    const onSuccess = jest.fn();
    const onError = jest.fn();

    locateOnce(onSuccess, onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
