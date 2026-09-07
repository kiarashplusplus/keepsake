import {
  IMAGE_VALIDATION_MESSAGES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  looksLikeHeic,
  projectedShortEdgePx,
  validateImageDimensions,
  validateSourceFile,
  type ImageValidationError,
} from "@/lib/images/validateImage";
import { FULL_EDGE_PX } from "@keepsake/contracts/photo";

describe("projectedShortEdgePx", () => {
  // The two measured values Finderly took off a real sharp pipeline. Reusing
  // them here means the two codebases agree on the arithmetic rather than
  // each having independently plausible rounding.
  it("collapses an extreme strip to a single pixel", () => {
    expect(projectedShortEdgePx(16000, 8, 2048)).toBe(1);
  });

  it("rounds rather than floors on the way down", () => {
    expect(projectedShortEdgePx(12000, 900, 2048)).toBe(154);
  });

  it("leaves an image that already fits untouched", () => {
    expect(projectedShortEdgePx(800, 600, 2048)).toBe(600);
  });
});

describe("validateImageDimensions", () => {
  it("accepts an ordinary photo", () => {
    expect(validateImageDimensions(4000, 3000, FULL_EDGE_PX)).toBeNull();
  });

  // The case that motivated all of this: the short edge clears the 320px
  // floor at source, so the old check passed it, and it resized to 2048x41.
  it("refuses a long thin strip whose short edge survives the source check", () => {
    expect(validateImageDimensions(20000, 400, FULL_EDGE_PX)).toBe("aspect_degenerate");
  });

  it("calls a merely-small image small rather than degenerate", () => {
    expect(validateImageDimensions(300, 300, FULL_EDGE_PX)).toBe("too_small");
  });

  // Guard validated by breaking it: changing the discriminator's `>` to `>=`
  // in validateImage.ts makes this fail, confirming the boundary is pinned
  // rather than merely nearby.
  it("accepts a photo whose projected short edge lands exactly on the floor", () => {
    expect(validateImageDimensions(FULL_EDGE_PX, 320, FULL_EDGE_PX)).toBeNull();
  });

  it("refuses one pixel below the floor", () => {
    expect(validateImageDimensions(FULL_EDGE_PX, 319, FULL_EDGE_PX)).toBe("too_small");
  });

  // An image already inside the fit-box is never scaled, so a short edge just
  // under the floor is "small", not "long and thin" — cropping it would only
  // make it worse. Guard validated by breaking it: dropping the `longer >
  // bound` clause from the discriminator makes this return
  // "aspect_degenerate" and fails here.
  it("does not call an unresized photo degenerate merely for being steep", () => {
    expect(validateImageDimensions(2000, 300, FULL_EDGE_PX)).toBe("too_small");
  });

  it("refuses dimensions it cannot read", () => {
    expect(validateImageDimensions(Number.NaN, 100, FULL_EDGE_PX)).toBe("dimensions_unreadable");
    expect(validateImageDimensions(0, 100, FULL_EDGE_PX)).toBe("dimensions_unreadable");
  });

  it("refuses a source with more pixels than the browser should be asked to hold", () => {
    const edge = Math.ceil(Math.sqrt(MAX_SOURCE_PIXELS)) + 1;
    expect(validateImageDimensions(edge, edge, FULL_EDGE_PX)).toBe("too_many_pixels");
  });
});

describe("validateSourceFile", () => {
  it("accepts the three types the picker offers", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(validateSourceFile({ type, size: 1000 })).toBeNull();
    }
  });

  // The picker's "I don't know" sentinels. These used to be rejected as
  // unsupported, losing a perfectly good photo on pickers that report
  // neither — the decode is the only thing that actually knows.
  it("defers an unknown MIME type to the decode instead of refusing", () => {
    expect(validateSourceFile({ type: "", size: 1000 })).toBeNull();
    expect(validateSourceFile({ type: "application/octet-stream", size: 1000 })).toBeNull();
    expect(validateSourceFile({ size: 1000 })).toBeNull();
  });

  it("defers HEIC to the decode, since a new-enough Safari can open it", () => {
    expect(validateSourceFile({ type: "image/heic", size: 1000 })).toBeNull();
  });

  it("refuses a type that positively is not an image", () => {
    expect(validateSourceFile({ type: "text/plain", size: 1000 })).toBe("unsupported_type");
    expect(validateSourceFile({ type: "application/pdf", size: 1000 })).toBe("unsupported_type");
    expect(validateSourceFile({ type: "video/mp4", size: 1000 })).toBe("unsupported_type");
  });

  it("refuses raster-less image subtypes", () => {
    expect(validateSourceFile({ type: "image/svg+xml", size: 1000 })).toBe("unsupported_type");
    expect(validateSourceFile({ type: "image/x-icon", size: 1000 })).toBe("unsupported_type");
  });

  it("refuses a source past the byte ceiling", () => {
    expect(validateSourceFile({ type: "image/jpeg", size: MAX_SOURCE_BYTES + 1 })).toBe("too_large");
    expect(validateSourceFile({ type: "image/jpeg", size: MAX_SOURCE_BYTES })).toBeNull();
  });
});

describe("looksLikeHeic", () => {
  it("recognises HEIC by MIME and by extension, case-insensitively", () => {
    expect(looksLikeHeic({ type: "image/heic" })).toBe(true);
    expect(looksLikeHeic({ type: "image/heif" })).toBe(true);
    expect(looksLikeHeic({ type: "", name: "IMG_0042.HEIC" })).toBe(true);
    expect(looksLikeHeic({ type: "", name: "photo.heif" })).toBe(true);
  });

  it("does not mistake an ordinary photo for one", () => {
    expect(looksLikeHeic({ type: "image/jpeg", name: "photo.jpg" })).toBe(false);
    expect(looksLikeHeic({})).toBe(false);
  });
});

describe("IMAGE_VALIDATION_MESSAGES", () => {
  // The Record type makes a missing key a compile error; this catches the
  // other half — a key present but left as a placeholder.
  it("has real copy for every error code", () => {
    for (const [code, message] of Object.entries(IMAGE_VALIDATION_MESSAGES) as [ImageValidationError, string][]) {
      expect(message.length).toBeGreaterThan(10);
      expect(code).not.toBe("");
    }
  });
});
