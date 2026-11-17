/**
 * Credentials for Wikimedia's authenticated rate-limit tiers.
 *
 * Two shapes, both of which `createClient({ auth })` accepts:
 *
 * - **OAuth 2 client credentials** (preferred, and what Wikimedia's policy
 *   recommends): register a consumer at
 *   https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2
 *   with the "client credentials" grant, then exchange the id and secret for
 *   short-lived access tokens. Requests count against the registering
 *   account's tier: 200/min for a new account, 2,000/min for an established
 *   editor, exempt for a bot-flagged one.
 * - **A static access token** (an owner-only consumer). The policy treats
 *   these as unauthenticated *unless the client returns the cookies the
 *   server sets*, which the HTTP client's cookie jar does.
 */

export const TOKEN_URL = "https://meta.wikimedia.org/w/rest.php/oauth2/access_token";

/** Refresh this long before the token says it expires. */
const EARLY_REFRESH_MS = 5 * 60_000;

export function clientCredentials({
  clientId,
  clientSecret,
  userAgent,
  tokenUrl = TOKEN_URL,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  if (!clientId || !clientSecret)
    throw new Error("clientCredentials needs clientId and clientSecret");
  let token = null;
  let expiresAt = 0;
  let pending = null;

  async function fetchToken() {
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "User-Agent": userAgent, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok || !body?.access_token) {
      // Never echo the request; the response body names the problem without the secret.
      throw new Error(
        `OAuth token request failed: HTTP ${response.status} ${(body?.error ?? text).toString().slice(0, 200)}`,
      );
    }
    token = body.access_token;
    expiresAt = now() + Number(body.expires_in ?? 3600) * 1000;
  }

  return {
    kind: "oauth2-client-credentials",
    async headers() {
      if (!token || now() > expiresAt - EARLY_REFRESH_MS) {
        pending ??= fetchToken().finally(() => (pending = null));
        await pending;
      }
      return { Authorization: `Bearer ${token}` };
    },
    invalidate() {
      token = null;
    },
  };
}

export function staticToken(accessToken) {
  if (!accessToken) throw new Error("staticToken needs a token");
  return {
    kind: "static-token",
    async headers() {
      return { Authorization: `Bearer ${accessToken}` };
    },
    invalidate() {
      // Nothing to refresh; the 401 will surface on the retry.
    },
  };
}

/**
 * Pick credentials from the environment, or null for unauthenticated.
 * WIKIMEDIA_CLIENT_ID + WIKIMEDIA_CLIENT_SECRET win over WIKIMEDIA_ACCESS_TOKEN.
 */
export function authFromEnv(env, { userAgent, fetchImpl } = {}) {
  if (env.WIKIMEDIA_CLIENT_ID && env.WIKIMEDIA_CLIENT_SECRET) {
    return clientCredentials({
      clientId: env.WIKIMEDIA_CLIENT_ID,
      clientSecret: env.WIKIMEDIA_CLIENT_SECRET,
      userAgent,
      fetchImpl,
    });
  }
  if (env.WIKIMEDIA_ACCESS_TOKEN) return staticToken(env.WIKIMEDIA_ACCESS_TOKEN);
  return null;
}
