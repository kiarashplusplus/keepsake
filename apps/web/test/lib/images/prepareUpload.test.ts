import { FULL_EDGE_PX } from "@keepsake/contracts/photo";
import { encode } from "blurhash";
import { MAX_THUMB_UPLOAD_BYTES, prepareUpload } from "@/lib/images/prepareUpload";
import { ImagePrepError } from "@/lib/images/resizeImage";
import { FALLBACK_BLURHASH } from "@/lib/images/blurhash";
import { convertHeicToJpeg } from "@/lib/images/heicFallback";
import { installCanvasStubs, type CanvasStubs } from "../../setup/canvasStubs";

// `jest.mock` is hoisted above the imports by babel-plugin-jest-hoist, so
// these take effect despite appearing below them.
jest.mock("blurhash", () => ({ encode: jest.fn(() => "LEHV6nWB2yk8pyo0adR*") }));
// The real module dynamic-imports a ~2.9 MB wasm decoder. Mocking it keeps the
// unit suite fast and lets us assert *whether* it was reached, which is the
// interesting part: a non-HEIC failure must never pay for that chunk.
jest.mock("@/lib/images/heicFallback", () => ({ convertHeicToJpeg: jest.fn() }));

function file(name = "photo.jpg", type = "image/jpeg", size = 2_000_000): File {
  const f = new File([new Uint8Array(8)], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("prepareUpload", () => {
  let stubs: CanvasStubs;

  afterEach(() => {
    stubs?.restore();
    jest.mocked(encode).mockClear();
    jest.mocked(convertHeicToJpeg).mockReset();
  });

  it("decodes the source exactly once for both variants and the blurhash", async () => {
    stubs = installCanvasStubs({ width: 4000, height: 3000 });
    const result = await prepareUpload(file());

    // The regression this whole module exists for: it used to be four
    // separate decodes of the same file, two of them concurrent.
    expect(stubs.createImageBitmap).toHaveBeenCalledTimes(1);
    expect(result.full.width).toBe(FULL_EDGE_PX);
    expect(result.thumb.width).toBe(640);
    expect(result.sourceWidth).toBe(4000);
    expect(stubs.close).toHaveBeenCalledTimes(1);
  });

  it("paints an opaque ground before drawing, so transparency doesn't encode as black", async () => {
    stubs = installCanvasStubs({ width: 800, height: 600 });
    await prepareUpload(file("logo.png", "image/png"));

    expect(stubs.fillRect).toHaveBeenCalled();
    const fillOrder = stubs.fillRect.mock.invocationCallOrder[0] ?? Infinity;
    const drawOrder = stubs.drawImage.mock.invocationCallOrder[0] ?? -Infinity;
    expect(fillOrder).toBeLessThan(drawOrder);
  });

  it("refuses a degenerate shape before spending a single encode", async () => {
    stubs = installCanvasStubs({ width: 20000, height: 400 });
    await expect(prepareUpload(file())).rejects.toMatchObject({ code: "aspect_degenerate" });
    // The load-bearing half: refusing after encoding would still have paid
    // for the thing the refusal exists to avoid.
    expect(stubs.toBlob).not.toHaveBeenCalled();
    expect(stubs.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a source with too many pixels", async () => {
    stubs = installCanvasStubs({ width: 20000, height: 20000 });
    await expect(prepareUpload(file())).rejects.toMatchObject({ code: "too_many_pixels" });
    expect(stubs.toBlob).not.toHaveBeenCalled();
  });

  // Desktop Chrome/Firefox will never decode HEIC natively (HEVC patent
  // licensing, not a gap anyone is closing), so a HEIC that fails the native
  // decode gets converted rather than refused.
  it("converts a HEIC the browser could not decode instead of refusing it", async () => {
    stubs = installCanvasStubs({ width: 4000, height: 3000 });
    stubs.createImageBitmap.mockRejectedValueOnce(new Error("decode error"));
    jest.mocked(convertHeicToJpeg).mockResolvedValue(new Blob([new Uint8Array(8)], { type: "image/jpeg" }));

    const result = await prepareUpload(file("IMG_1.HEIC", ""));

    expect(convertHeicToJpeg).toHaveBeenCalledTimes(1);
    expect(result.full.width).toBe(FULL_EDGE_PX);
  });

  it("surfaces a HEIC problem when the conversion itself fails", async () => {
    stubs = installCanvasStubs({ width: 800, height: 600 });
    stubs.createImageBitmap.mockRejectedValue(new Error("decode error"));
    jest.mocked(convertHeicToJpeg).mockRejectedValue(new ImagePrepError("heic_unsupported"));

    await expect(prepareUpload(file("IMG_1.HEIC", ""))).rejects.toMatchObject({ code: "heic_unsupported" });
  });

  // The load-bearing half of the lazy import: a corrupt JPEG must not drag a
  // 2.9 MB decoder onto the wire to tell the giver it's corrupt.
  it("reports a failed decode of an ordinary file generically, without loading the decoder", async () => {
    stubs = installCanvasStubs({ width: 800, height: 600 });
    stubs.createImageBitmap.mockRejectedValue(new Error("decode error"));

    await expect(prepareUpload(file())).rejects.toMatchObject({ code: "decode_failed" });
    expect(convertHeicToJpeg).not.toHaveBeenCalled();
  });

  it("does not try to convert when the decode merely timed out", async () => {
    jest.useFakeTimers();
    stubs = installCanvasStubs({ width: 800, height: 600 });
    stubs.createImageBitmap.mockReturnValue(new Promise(() => undefined));

    const pending = prepareUpload(file("IMG_1.HEIC", ""));
    const assertion = expect(pending).rejects.toMatchObject({ code: "timed_out" });
    await jest.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(convertHeicToJpeg).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("times out a decode that never settles instead of hanging the give flow", async () => {
    jest.useFakeTimers();
    stubs = installCanvasStubs({ width: 800, height: 600 });
    stubs.createImageBitmap.mockReturnValue(new Promise(() => undefined));

    const pending = prepareUpload(file());
    const assertion = expect(pending).rejects.toMatchObject({ code: "timed_out" });
    await jest.advanceTimersByTimeAsync(20_000);
    await assertion;
    jest.useRealTimers();
  });

  it("degrades to a fallback blurhash rather than failing the upload", async () => {
    stubs = installCanvasStubs({ width: 800, height: 600 });
    jest.mocked(encode).mockImplementation(() => {
      throw new Error("encode failed");
    });

    const result = await prepareUpload(file());
    expect(result.blurhash).toBe(FALLBACK_BLURHASH);
    expect(result.full.blob.size).toBeGreaterThan(0);
  });

  it("steps the quality ladder down when an encode overshoots its budget", async () => {
    stubs = installCanvasStubs({ width: 800, height: 600 });
    stubs.setEncodedSize(MAX_THUMB_UPLOAD_BYTES + 1);

    await prepareUpload(file());
    const qualities = stubs.toBlob.mock.calls.map((call) => call[2] as number);
    // The full variant fits its larger budget in one pass; the thumb walks
    // the whole ladder and stops rather than looping.
    expect(qualities).toEqual([0.85, 0.85, 0.75, 0.65, 0.55]);
  });

  it("rejects an already-aborted request without touching the canvas", async () => {
    stubs = installCanvasStubs({ width: 800, height: 600 });
    const controller = new AbortController();
    controller.abort();

    await expect(prepareUpload(file(), { signal: controller.signal })).rejects.toThrow("Aborted");
    expect(stubs.createImageBitmap).not.toHaveBeenCalled();
    expect(stubs.toBlob).not.toHaveBeenCalled();
  });

  it("refuses a non-image file before decoding it", async () => {
    stubs = installCanvasStubs({ width: 800, height: 600 });
    await expect(prepareUpload(file("notes.pdf", "application/pdf"))).rejects.toMatchObject({
      code: "unsupported_type",
    });
    expect(stubs.createImageBitmap).not.toHaveBeenCalled();
  });

  it("carries user-facing copy on every failure", async () => {
    stubs = installCanvasStubs({ width: 20000, height: 400 });
    await prepareUpload(file()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ImagePrepError);
      expect((error as ImagePrepError).message).toContain("long and thin");
    });
  });
});
