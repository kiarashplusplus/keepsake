/**
 * Fires the browser geolocation prompt. Call `locateOnce` directly inside a
 * tap/press handler — never after an `await` — because iOS Safari can
 * silently drop the permission prompt once the call is no longer inside the
 * synchronous scope of the original user gesture (the same recipe Finderly
 * uses in `HireProScreen.tsx`'s `handleUseCurrentLocation`).
 *
 * `getCurrentPosition`'s own `timeout` option isn't trusted on its own:
 * some browsers just never call either callback once permission is denied
 * at the OS level, rather than firing the error callback promptly. The
 * `watchdog` here is a second, independent timer, and `settled` makes sure
 * the watchdog and the real callback can't both resolve the caller.
 */

export type GeoCoords = { lat: number; lng: number };

const WATCHDOG_MS = 15_000;
const GETCURRENTPOSITION_TIMEOUT_MS = 15_000;

function messageForPositionError(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return "Location blocked. Allow location access, or enter it manually.";
  if (error.code === error.POSITION_UNAVAILABLE) return "Location unavailable right now. Enter it manually.";
  if (error.code === error.TIMEOUT) return "Location request timed out. Enter it manually.";
  return "Couldn't get your location. Enter it manually.";
}

/**
 * Requests the current position exactly once. `onSuccess`/`onError` fire at
 * most once between them, and never after the other already has (the
 * `settled` guard). Must be invoked synchronously from the caller's own
 * event handler — see the file header.
 */
export function locateOnce(onSuccess: (coords: GeoCoords) => void, onError: (message: string) => void): void {
  if (typeof navigator === "undefined" || typeof navigator.geolocation === "undefined") {
    onError("Location isn't available in this browser. Enter it manually.");
    return;
  }

  let settled = false;
  const watchdog = setTimeout(() => {
    if (settled) return;
    settled = true;
    onError("Location request timed out. Enter it manually.");
  }, WATCHDOG_MS);

  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      const { latitude, longitude } = position.coords;
      // `Number.isFinite`, not a falsy check: a coordinate of exactly 0 is
      // a real place, not a missing value.
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        onError("Unable to access your location. Enter it manually.");
        return;
      }
      onSuccess({ lat: latitude, lng: longitude });
    },
    (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      onError(messageForPositionError(error));
    },
    { enableHighAccuracy: true, timeout: GETCURRENTPOSITION_TIMEOUT_MS, maximumAge: 0 },
  );
}
