/** Full-length SHA-256 hex digest, used where truncation isn't wanted (owner
 * token hashing, idempotency scoping) — as opposed to
 * `src/moderation/budget.ts`'s deliberately truncated 128-bit digest, which
 * exists purely to keep KV keys short. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digestBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digestBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
