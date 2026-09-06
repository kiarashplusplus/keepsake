import {
  assignMasonryColumns,
  clampCardAspectRatio,
  masonryColumnCount,
  type MasonryInput,
} from "@/lib/masonry";

describe("masonryColumnCount", () => {
  it("returns 1/2/3/4 columns at the 0/520/820/1100px thresholds", () => {
    expect(masonryColumnCount(0)).toBe(1);
    expect(masonryColumnCount(519)).toBe(1);
    expect(masonryColumnCount(520)).toBe(2);
    expect(masonryColumnCount(819)).toBe(2);
    expect(masonryColumnCount(820)).toBe(3);
    expect(masonryColumnCount(1099)).toBe(3);
    expect(masonryColumnCount(1100)).toBe(4);
    expect(masonryColumnCount(2000)).toBe(4);
  });
});

describe("clampCardAspectRatio", () => {
  it("clamps a tall portrait to 3:4", () => {
    expect(clampCardAspectRatio(100, 1000)).toBeCloseTo(3 / 4);
  });

  it("clamps a wide landscape to 4:3", () => {
    expect(clampCardAspectRatio(1000, 100)).toBeCloseTo(4 / 3);
  });

  it("passes an in-range ratio through unchanged", () => {
    expect(clampCardAspectRatio(800, 800)).toBeCloseTo(1);
  });
});

describe("assignMasonryColumns", () => {
  function square(key: string, size: number): MasonryInput<string> {
    return { key, item: key, width: size, height: size };
  }

  it("is deterministic for the same inputs", () => {
    const items = [square("a", 800), square("b", 800), square("c", 800)];
    const first = assignMasonryColumns(items, 2, 300, 16);
    const second = assignMasonryColumns(items, 2, 300, 16);
    expect(first).toEqual(second);
  });

  it("fills columns left to right when every item is the same height", () => {
    const items = [square("a", 800), square("b", 800), square("c", 800), square("d", 800)];
    const placements = assignMasonryColumns(items, 2, 300, 16);
    expect(placements.map((p) => p.column)).toEqual([0, 1, 0, 1]);
  });

  it("places the next item in the shortest column, not just round-robin", () => {
    // "a" is a tall portrait (clamped to 3:4 -> tall render height), "b" is a
    // wide landscape (clamped to 4:3 -> short render height). After those
    // two, column 1 (which got the short "b") is shorter, so "c" should land
    // there rather than column 0.
    const items: MasonryInput<string>[] = [
      { key: "a", item: "a", width: 100, height: 1000 },
      { key: "b", item: "b", width: 1000, height: 100 },
      { key: "c", item: "c", width: 400, height: 400 },
    ];
    const placements = assignMasonryColumns(items, 2, 300, 0);
    const byKey = Object.fromEntries(placements.map((p) => [p.key, p]));
    expect(byKey.a?.column).toBe(0);
    expect(byKey.b?.column).toBe(1);
    expect(byKey.c?.column).toBe(1);
  });

  it("breaks ties by the lowest column index", () => {
    const items = [square("a", 500)];
    const placements = assignMasonryColumns(items, 3, 300, 16);
    expect(placements[0]?.column).toBe(0);
  });

  // Validated by breaking it: temporarily changed `candidate <
  // (columnHeights[shortest] ?? 0)` to `<=` in src/lib/masonry.ts, which
  // flips the tie-break to the LAST equally-short column — this test failed
  // (expected 0, got 2) as expected, confirming it actually exercises the
  // tie-break rule rather than passing vacuously. Reverted before committing.
});
