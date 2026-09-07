/**
 * Kiarash's one admin credential: `Authorization: Bearer <ADMIN_TOKEN>`,
 * compared in constant time so a timing side-channel can't be used to guess
 * it one byte at a time. A manual constant-time loop rather than Cloudflare's
 * non-standard `crypto.subtle.timingSafeEqual` extension: this repo's
 * tsconfig ends up with `lib.dom.d.ts` pulled in transitively (via
 * `@types/jsdom`, itself pulled in by the test toolchain), whose *standard*
 * `SubtleCrypto` interface doesn't declare that method and shadows
 * workerd's richer one for typechecking purposes — a manual loop needs no
 * engine-specific extension and has no such ambient-type dependency.
 *
 * 401 (not 403) on every failure mode — secret unset, header missing, header
 * wrong — so a caller can't distinguish "admin isn't configured yet" from
 * "wrong token" from the response alone. Admin is a single global secret
 * with no admin-user table, so there is nothing else to check once the token
 * matches: no session, no expiry, no second admin (see docs/runbooks/admin.md).
 */
import type { Context, Next } from "hono";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";

type AdminCtx = Context<{ Bindings: Env }>;

/**
 * Visits every byte of the longer input regardless of where (or whether) a
 * mismatch occurs, so how much of the token an attacker got right isn't
 * observable from timing. A length mismatch is folded into the result
 * rather than causing an early return — the token's length isn't a secret
 * worth protecting on its own (it's a fixed, known shape), but returning
 * early on it would still make the loop below run for zero iterations on a
 * wildly-wrong-length guess, a distinguishable timing signal this avoids by
 * always running the full `Math.max` length.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let diff = aBytes.byteLength ^ bBytes.byteLength;
  const length = Math.max(aBytes.byteLength, bBytes.byteLength);
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** The one 401 body every failure mode returns. The docblock above has
 * always claimed a caller can't tell "admin isn't configured yet" from
 * "wrong token" from the response alone; until the launch audit that was
 * only true of the status code, because the two branches below returned
 * distinguishable messages. One string for both closes the gap the comment
 * already promised was closed. */
const UNAUTHORIZED_MESSAGE = "Invalid admin token.";

export function adminAuth() {
  return async (c: AdminCtx, next: Next) => {
    const secret = c.env.ADMIN_TOKEN;
    if (!secret) {
      return fail(c, "unauthorized", UNAUTHORIZED_MESSAGE, 401);
    }

    const header = c.req.header("Authorization");
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!provided || !timingSafeEqualStrings(provided, secret)) {
      return fail(c, "unauthorized", UNAUTHORIZED_MESSAGE, 401);
    }

    await next();
  };
}
