/**
 * Races `promise` against a timer, throwing `Error("<label> timed out after
 * <ms>ms")` if the timer wins.
 *
 * A deliberate duplicate of `apps/api/src/lib/withTimeout.ts`, which is
 * byte-for-byte the same function. The web bundle cannot import from
 * `apps/api`, and the only shared workspace packages are `contracts`,
 * `tokens` and `observability` — none of which is a runtime-helper package.
 * Creating one to host twelve lines is more machinery than the duplication
 * costs, and `packages/contracts/src/photo.ts` is this repo's own record of
 * what a "shared" constant nobody actually shares does to a reader. If a
 * third copy ever wants to exist, that is the signal to make the package.
 *
 * Why the image pipeline needs it at all: `createImageBitmap` and
 * `canvas.toBlob` have no timeout of their own and are not cancellable. A
 * decode that never settles used to leave a give-flow tile at "uploading…"
 * forever — and because `canContinue` in `app/give/index.tsx` is gated on
 * `!isUploading`, it also disabled the Continue button for the whole flow
 * with no error text and no way out but a reload.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
