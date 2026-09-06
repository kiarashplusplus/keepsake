import { fitBox } from "@/lib/images/resizeImage";

describe("fitBox", () => {
  it("does not upscale an image already within the max edge", () => {
    expect(fitBox(400, 300, 640)).toEqual({ width: 400, height: 300 });
  });

  it("does not upscale when a dimension exactly equals the max edge", () => {
    expect(fitBox(640, 480, 640)).toEqual({ width: 640, height: 480 });
  });

  it("scales a landscape image down so the long edge matches maxEdge", () => {
    expect(fitBox(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
  });

  it("scales a portrait image down using the taller edge", () => {
    expect(fitBox(1200, 4000, 2000)).toEqual({ width: 600, height: 2000 });
  });

  it("never rounds a dimension down to zero for extreme aspect ratios", () => {
    const result = fitBox(10000, 1, 640);
    expect(result.width).toBe(640);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });
});
