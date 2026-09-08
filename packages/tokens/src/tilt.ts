/**
 * The deterministic table-tilt — v3, "Polaroids on a table."
 *
 * A print resting on a table is never quite square to the edge, and the same
 * print is at the same angle every time you look at it. That is the whole
 * idea: `tiltDegForId` hashes a listing id into a fixed angle within
 * `motion.tiltRangeDeg`, so a keepsake leans the same way in the feed, on its
 * own page, and on its share card, forever.
 *
 * This lives in `@keepsake/tokens` rather than in `apps/web` because it now
 * has **two** renderers: `apps/web/src/lib/masonry.ts` (react-native-web
 * transforms) and `apps/api/src/og/card.ts` (an SVG `rotate()` rasterised by
 * resvg inside the Worker). A duplicated copy of the hash would let the share
 * card and the feed disagree about which way a print leans, which is exactly
 * the kind of drift nobody would file a bug about and everybody would feel.
 * `masonry.ts` re-exports these so its existing call sites are unchanged.
 *
 * The functions are pure and dependency-free by design: the Worker bundle
 * must not pull in anything from `apps/web`.
 */

/**
 * FNV-1a, 32-bit. Chosen for being short, dependency-free and stable across
 * runtimes — this must produce identical output in a browser, in a Worker and
 * in the Node preview harness, so anything platform-provided (`crypto`, hash
 * seeds that vary per process) is disqualified.
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A deterministic tilt in degrees within [-rangeDeg, rangeDeg], derived from
 * `id`. Two different ids landing on the same tilt is fine (and expected);
 * what matters is that a given id always lands on the same tilt. */
export function tiltDegForId(id: string, rangeDeg: number): number {
  const hash = hashString(id);
  const unit = (hash % 2001) / 1000 - 1; // [-1, 1]
  return unit * rangeDeg;
}

/** A deterministic vertical offset in [0, maxOffset], derived from `id` with
 * a different mixing constant than `tiltDegForId` so the two don't correlate
 * (a print that leans hard right isn't also always pushed furthest down). */
export function verticalOffsetForId(id: string, maxOffset: number): number {
  const hash = hashString(`v:${id}`);
  return ((hash % 1000) / 1000) * maxOffset;
}
