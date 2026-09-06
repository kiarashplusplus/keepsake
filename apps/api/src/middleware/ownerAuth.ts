/**
 * Owner identity, per `docs/design/identity.md`: no accounts, a device-bound
 * secret token (`Authorization: Bearer ks_<43 base64url chars>`) hashed and
 * matched/created against `owners.token_hash`. Nothing server-side ever sees
 * or stores the raw token — only its SHA-256 hex digest.
 */
import type { Context, Next } from "hono";
import { OwnerTokenSchema } from "@keepsake/contracts/owner";
import type { Env } from "../env.js";
import { sha256Hex } from "../lib/digest.js";
import { ulid } from "../lib/ids.js";
import { fail } from "../lib/respond.js";

export interface OwnerRow {
  id: string;
  token_hash: string;
  email: string | null;
  email_verified_at: number | null;
  banned_at: number | null;
  ban_reason: string | null;
  created_at: number;
  last_seen_at: number;
}

export type OwnerVariables = { owner: OwnerRow };
type OwnerCtx = Context<{ Bindings: Env; Variables: OwnerVariables }>;

/** Only bumped once per hour per owner, so a chatty dashboard doesn't turn
 * every request into a write. */
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

function bearerToken(c: OwnerCtx): string | undefined {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

export interface OwnerAuthOptions {
  /** Upserts a fresh `owners` row the first time this token is seen, rather
   * than 401-ing an owner token the client just minted. Used on the two
   * write endpoints that can be a giver's very first request (photo upload,
   * listing create) — everywhere else the owner must already exist. */
  createIfMissing?: boolean;
}

export function ownerAuth(options: OwnerAuthOptions = {}) {
  return async (c: OwnerCtx, next: Next) => {
    const token = bearerToken(c);
    if (!token || !OwnerTokenSchema.safeParse(token).success) {
      return fail(c, "unauthorized", "Missing or invalid owner token.", 401);
    }

    const tokenHash = await sha256Hex(token);
    const db = c.env.DB;

    let owner = await db
      .prepare(
        "SELECT id, token_hash, email, email_verified_at, banned_at, ban_reason, created_at, last_seen_at FROM owners WHERE token_hash = ?",
      )
      .bind(tokenHash)
      .first<OwnerRow>();

    if (!owner) {
      if (!options.createIfMissing) {
        return fail(c, "unauthorized", "Unknown owner token.", 401);
      }

      const now = Date.now();
      const id = ulid(now);
      // ON CONFLICT DO NOTHING covers two near-simultaneous first requests
      // from the same freshly-minted token (photo upload + listing create
      // firing back to back) racing to insert the same token_hash.
      await db
        .prepare(
          `INSERT INTO owners (id, token_hash, created_at, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(token_hash) DO NOTHING`,
        )
        .bind(id, tokenHash, now, now)
        .run();

      owner = await db
        .prepare(
          "SELECT id, token_hash, email, email_verified_at, banned_at, ban_reason, created_at, last_seen_at FROM owners WHERE token_hash = ?",
        )
        .bind(tokenHash)
        .first<OwnerRow>();

      if (!owner) {
        return fail(c, "internal", "Could not establish owner identity.", 500);
      }
    } else if (owner.banned_at !== null) {
      return fail(c, "forbidden", "This account has been banned.", 403);
    } else {
      const now = Date.now();
      if (now - owner.last_seen_at > LAST_SEEN_THROTTLE_MS) {
        await db.prepare("UPDATE owners SET last_seen_at = ? WHERE id = ?").bind(now, owner.id).run();
        owner = { ...owner, last_seen_at: now };
      }
    }

    c.set("owner", owner);
    await next();
  };
}
