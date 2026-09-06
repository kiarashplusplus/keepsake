/**
 * Pure JS masonry column assignment for the feed grid. Deliberately NOT CSS
 * columns (which re-flow every card top-to-bottom on append — see the build
 * plan's "Masonry" section) and NOT a virtualized list (no benefit on web at
 * feed-page sizes). Deterministic before any image has loaded because it
 * only needs each photo's `width`/`height`, which the API already returns.
 */

/** Width thresholds for the 2nd/3rd/4th column — 1 column is the baseline
 * below the first threshold, giving 1/2/3/4 columns at 0/520/820/1100px. */
export const MASONRY_BREAKPOINTS = [520, 820, 1100] as const;

export function masonryColumnCount(containerWidth: number): number {
  let columns = 1;
  for (const breakpoint of MASONRY_BREAKPOINTS) {
    if (containerWidth >= breakpoint) columns += 1;
  }
  return columns;
}

/** Card photos never go more extreme than a 3:4 portrait or 4:3 landscape —
 * clamps the raw aspect ratio (width / height) into that band. */
export function clampCardAspectRatio(width: number, height: number): number {
  const raw = width / height;
  const MIN = 3 / 4;
  const MAX = 4 / 3;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(MAX, Math.max(MIN, raw));
}

export type MasonryInput<T> = {
  key: string;
  width: number;
  height: number;
  item: T;
};

export type MasonryPlacement<T> = {
  key: string;
  item: T;
  /** Zero-based column index. */
  column: number;
  /** Top offset within that column, in the same units as `columnWidth`. */
  top: number;
  /** Rendered card height (photo height only) at `columnWidth`. */
  height: number;
};

/**
 * Assigns each item to the shortest column so far (ties broken by lowest
 * column index), in input order. Pure function: same inputs always produce
 * the same placement, so it can run before any image has actually loaded.
 */
export function assignMasonryColumns<T>(
  items: readonly MasonryInput<T>[],
  columns: number,
  columnWidth: number,
  gap: number,
): MasonryPlacement<T>[] {
  const safeColumns = Math.max(1, Math.floor(columns));
  const columnHeights = new Array<number>(safeColumns).fill(0);
  const placements: MasonryPlacement<T>[] = [];

  for (const input of items) {
    let shortest = 0;
    for (let c = 1; c < safeColumns; c += 1) {
      const candidate = columnHeights[c] ?? 0;
      if (candidate < (columnHeights[shortest] ?? 0)) shortest = c;
    }

    const aspect = clampCardAspectRatio(input.width, input.height);
    const photoHeight = columnWidth / aspect;
    const top = columnHeights[shortest] ?? 0;

    placements.push({ key: input.key, item: input.item, column: shortest, top, height: photoHeight });
    columnHeights[shortest] = top + photoHeight + gap;
  }

  return placements;
}

/** Groups items into per-column arrays (preserving each column's original
 * relative order) for a simple flex-row-of-columns render — the actual DOM
 * layout doesn't need the computed `top`/`height` once the item is in the
 * right column and position, since real card height (photo + text) flows
 * naturally in CSS; only the *assignment* needs to be deterministic. */
export function groupIntoColumns<T>(
  items: readonly MasonryInput<T>[],
  columns: number,
  columnWidth: number,
  gap: number,
): T[][] {
  const placements = assignMasonryColumns(items, columns, columnWidth, gap);
  const groups: T[][] = Array.from({ length: Math.max(1, Math.floor(columns)) }, () => []);
  for (const placement of placements) {
    groups[placement.column]?.push(placement.item);
  }
  return groups;
}

/** Total content height across all columns (for the container's height, if
 * a caller needs it explicitly rather than sizing via absolute-positioned
 * children inside a relatively-positioned parent). */
export function masonryContainerHeight<T>(placements: readonly MasonryPlacement<T>[]): number {
  let max = 0;
  for (const placement of placements) {
    max = Math.max(max, placement.top + placement.height);
  }
  return max;
}
