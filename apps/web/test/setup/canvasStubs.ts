/**
 * Minimal `createImageBitmap` / canvas stubs for the upload-pipeline tests.
 *
 * Installed per-file rather than from `jest.config.js`'s `setupFiles`, so no
 * other suite silently gains a fake canvas it didn't ask for.
 *
 * jsdom implements neither `createImageBitmap` nor a 2D context —
 * `getContext("2d")` returns `null` and `toBlob` doesn't exist — and the
 * alternative (installing `node-canvas`) would add a native build to CI in
 * order to test *the browser's* rasteriser rather than our own logic. What
 * these stubs buy is the orchestration: how many times we decode, what we
 * refuse before we encode, and what we do when a step fails. The real canvas
 * runs in `e2e/give.spec.ts`.
 */

export type CanvasStubs = {
  createImageBitmap: jest.Mock;
  toBlob: jest.Mock;
  fillRect: jest.Mock;
  drawImage: jest.Mock;
  getImageData: jest.Mock;
  close: jest.Mock;
  /** Size, in bytes, that the next `toBlob` call reports. */
  setEncodedSize: (bytes: number) => void;
  restore: () => void;
};

export function installCanvasStubs(options: { width: number; height: number }): CanvasStubs {
  const close = jest.fn();
  const bitmap = { width: options.width, height: options.height, close };

  const createImageBitmapMock = jest.fn().mockResolvedValue(bitmap);
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = createImageBitmapMock;

  const fillRect = jest.fn();
  const drawImage = jest.fn();
  const getImageData = jest.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }));

  let encodedSize = 1024;
  const toBlob = jest.fn((callback: BlobCallback, type?: string) => {
    callback(new Blob([new Uint8Array(encodedSize)], { type: type ?? "image/jpeg" }));
  });

  const getContextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ fillRect, drawImage, getImageData, fillStyle: "" } as unknown as CanvasRenderingContext2D);

  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = toBlob as unknown as HTMLCanvasElement["toBlob"];

  return {
    createImageBitmap: createImageBitmapMock,
    toBlob,
    fillRect,
    drawImage,
    getImageData,
    close,
    setEncodedSize: (bytes: number) => {
      encodedSize = bytes;
    },
    restore: () => {
      getContextSpy.mockRestore();
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      delete (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap;
    },
  };
}
