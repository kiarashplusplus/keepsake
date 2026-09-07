/**
 * Issue #87: the key `burst()` hands a `[[ratelimits]]` binding used to be
 * `sha256Hex(clientIPFrom(request))` — a bare digest of the address, stable
 * for as long as the caller keeps that address, with no expiry of its own.
 * `src/moderation/budget.ts` had always salted its KV keys with the UTC day,
 * and `apps/site/public/privacy.html`'s "Rate limiting" section describes
 * only that shape ("combined with the date", worked example
 * `sha256("2026-09-05:203.0.113.4")`). So the page was accurate about one
 * path and false about the other, and nothing could notice: no test had ever
 * looked at the key.
 *
 * These tests look at the key. `installRecordingRateLimiter` swaps the
 * binding for one that records what it was handed and allows the request, so
 * the assertions below are about the actual value the deployed limiter would
 * count against — not about a helper called in isolation.
 *
 * The companion static guard is `tools/preflight/preflight.mjs`'s `ip-digest`
 * check, which refuses a *new* hashing site that skips `dailyIpDigest`.
 * Together: one proves the shape at the call site that exists, the other
 * refuses the ones that don't exist yet.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { dailyIpDigest, sha256Hex } from "../src/lib/digest.js";
import { todayISO } from "../src/lib/day.js";
import { todayIPKey } from "../src/moderation/budget.js";
import { freshClientIp, installRecordingRateLimiter } from "./helpers.js";

const RealDate = globalThis.Date;

/** A `Date` whose "now" is `offsetMs` in the future, for crossing a UTC
 * midnight without waiting for one. Only `now()` and the zero-argument
 * constructor move; every other form is the real thing, which is all
 * `todayISO()` (`new Date().toISOString()`) needs. */
function shiftedDate(offsetMs: number): DateConstructor {
  class ShiftedDate extends RealDate {
    constructor(...args: [] | [value: number | string | Date]) {
      if (args.length === 0) {
        super(RealDate.now() + offsetMs);
      } else {
        super(args[0]);
      }
    }

    static override now(): number {
      return RealDate.now() + offsetMs;
    }
  }
  return ShiftedDate as unknown as DateConstructor;
}

describe("client-IP digests rotate daily", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("burst() keys the limiter by the day-salted digest, not a bare hash of the address", async () => {
    const recorder = installRecordingRateLimiter("RL_READ");
    restore = recorder.restore;
    const ip = freshClientIp();

    const res = await SELF.fetch("http://x/api/feed", { headers: { "CF-Connecting-IP": ip } });
    expect(res.status).toBe(200);

    expect(recorder.keys).toHaveLength(1);
    // The assertion that fails if the day is dropped again: a bare
    // `sha256Hex(ip)` is what shipped before #87, and it is exactly what the
    // privacy page says we do not keep.
    expect(recorder.keys[0]).not.toBe(await sha256Hex(ip));
    expect(recorder.keys[0]).toBe(await dailyIpDigest(ip));
    expect(recorder.keys[0]).toBe(await sha256Hex(`${todayISO()}:${ip}`));
  });

  it("the same address gets an unrelated limiter key tomorrow", async () => {
    const recorder = installRecordingRateLimiter("RL_READ");
    restore = () => {
      recorder.restore();
      globalThis.Date = RealDate;
    };
    const ip = freshClientIp();

    await SELF.fetch("http://x/api/feed", { headers: { "CF-Connecting-IP": ip } });

    // Move the whole isolate's clock a day forward — `SELF` runs the real
    // Worker in this isolate, so `todayISO()` inside `burst()` sees this too.
    // This is the day-boundary behaviour the middleware's comment reasons
    // about (one bucket reset a night), observed rather than asserted from
    // arithmetic: computing tomorrow's digest here and finding it differs
    // from today's would be true of any two different inputs and could never
    // fail.
    globalThis.Date = shiftedDate(86_400_000);
    await SELF.fetch("http://x/api/feed", { headers: { "CF-Connecting-IP": ip } });

    expect(recorder.keys).toHaveLength(2);
    expect(recorder.keys[1]).not.toBe(recorder.keys[0]);
    globalThis.Date = RealDate;
    expect(recorder.keys[0]).toBe(await dailyIpDigest(ip));
  });

  it("keys two different addresses apart on the same day (control)", async () => {
    const recorder = installRecordingRateLimiter("RL_READ");
    restore = recorder.restore;

    await SELF.fetch("http://x/api/feed", { headers: { "CF-Connecting-IP": freshClientIp() } });
    await SELF.fetch("http://x/api/feed", { headers: { "CF-Connecting-IP": freshClientIp() } });

    expect(recorder.keys).toHaveLength(2);
    expect(recorder.keys[0]).not.toBe(recorder.keys[1]);
  });

  it("burst() and the KV daily budget derive from one digest of one input", async () => {
    // `budget.ts` truncates to 128 bits to keep KV keys short; the bytes are
    // the same bytes. If these two ever stop agreeing, one of the two paths
    // has grown its own idea of what identifies a caller — which is how #87
    // happened in the first place.
    const ip = freshClientIp();
    const key = await todayIPKey("listing", ip);
    expect(key).toBe(`budget:ip:listing:${(await dailyIpDigest(ip)).slice(0, 32)}:${todayISO()}`);
  });

  it("never writes the address itself into KV", async () => {
    // The stored key is a digest, per the privacy page's "we never handle or
    // store your address in the clear at all".
    const ip = freshClientIp();
    const key = await todayIPKey("listing", ip);
    expect(key).not.toContain(ip);
    await env.KV.put(key, "1", { expirationTtl: 60 });
    const listed = await env.KV.list({ prefix: "budget:ip:" });
    expect(listed.keys.some((k) => k.name.includes(ip))).toBe(false);
  });
});
