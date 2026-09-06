import { PostalLookup, type Country, type PostalLookup as PostalLookupT } from "@keepsake/contracts/geo";
import { apiFetch, ApiError } from "@/api/client";

export type LookupPostalCodeInput = {
  country: Country;
  code: string;
  signal?: AbortSignal;
};

/** `GET /api/geo/lookup` — returns `null` on a 404 (no such postcode yet),
 * rather than throwing, since "not found" is an expected, displayable state
 * on the details step ("We don't know that postcode yet"). Any other
 * failure (network, 5xx, malformed response) still throws. */
export async function lookupPostalCode(input: LookupPostalCodeInput): Promise<PostalLookupT | null> {
  const params = new URLSearchParams({ country: input.country, code: input.code });
  try {
    const data = await apiFetch<unknown>(`/api/geo/lookup?${params.toString()}`, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return PostalLookup.parse(data);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null;
    throw error;
  }
}
