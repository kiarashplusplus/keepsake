/**
 * Issue #310, part two — the mechanism the first pass's footer promised and
 * nothing yet honored. Four things this file proves, each of which fails
 * without the corresponding piece of the mechanism:
 *
 * 1. A suppressed address gets no mail for a suppressible kind, but still
 *    gets mail for a kind `TRANSACTIONAL_EMAIL_KINDS` exempts — the product
 *    decision `src/email/sendMail.ts` documents on that constant.
 * 2. The placeholder `templates/shared.ts` embeds in every footer becomes a
 *    real, per-recipient URL by the time a message is actually sent, in
 *    both `html` and `text`, and `List-Unsubscribe`/`List-Unsubscribe-Post`
 *    land on the outgoing message.
 * 3. `GET /api/unsubscribe/:token` — the shape a link-scanner prefetches —
 *    never changes anything. Only `POST` does.
 * 4. Unsubscribing and resubscribing round-trip through the real HTTP
 *    routes and are reflected back in `sendMail`'s own suppression check —
 *    not two mechanisms that happen to agree today.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { sendMail, TRANSACTIONAL_EMAIL_KINDS, type EmailKind } from "../src/email/sendMail.js";
import { UNSUBSCRIBE_LINK_PLACEHOLDER } from "../src/email/templates/shared.js";
import { unsubscribeToken, unsubscribeWebUrl, unsubscribeApiUrl, isUnsubscribed } from "../src/email/unsubscribe.js";
import { installFakeEmail, removeFakeEmail, readOk, setTestEnvVar, type CapturedEmail } from "./helpers.js";

function testMessage(kind: EmailKind, to: string): Parameters<typeof sendMail>[1] {
  return {
    kind,
    to,
    subject: "s",
    html: `<p>hi</p>${UNSUBSCRIBE_LINK_PLACEHOLDER}`,
    text: `hi ${UNSUBSCRIBE_LINK_PLACEHOLDER}`,
  };
}

describe("TRANSACTIONAL_EMAIL_KINDS (the product decision)", () => {
  it("exempts every kind this fix argues is a self-initiated or delivered transaction", () => {
    // Named individually, not just counted, so a future edit that silently
    // drops one of these has to change a line a reviewer can see is wrong —
    // "chosen" and "confirm_request" in particular are the two the task
    // that created this fix calls out by name as messages that must not be
    // suppressible.
    for (const kind of ["verify_email", "confirm_request", "request_received", "chosen", "recover", "admin_test", "admin_digest"] as const) {
      expect(TRANSACTIONAL_EMAIL_KINDS.has(kind), kind).toBe(true);
    }
  });

  it("does not exempt new_request — the one kind this fix can suppress", () => {
    expect(TRANSACTIONAL_EMAIL_KINDS.has("new_request")).toBe(false);
  });
});

describe("sendMail() consults suppression before sending", () => {
  afterEach(() => removeFakeEmail());

  it("blocks a suppressible kind for an unsubscribed address, and records it in email_events", async () => {
    const to = "owner-suppressed-1@keepsake.ing";
    const token = await unsubscribeToken(env as unknown as Env, to);
    expect(token).toBeTruthy();
    await SELF.fetch(`http://x/api/unsubscribe/${token}`, { method: "POST" });

    const sent = installFakeEmail();
    const result = await sendMail(env as unknown as Env, testMessage("new_request", to));

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("blocked_unsubscribed");
    expect(sent).toHaveLength(0);

    const row = await env.DB.prepare("SELECT ok, error, kind FROM email_events WHERE id = ?")
      .bind(result.eventId)
      .first<{ ok: number; error: string; kind: string }>();
    expect(row?.ok).toBe(0);
    expect(row?.error).toBe("blocked_unsubscribed");
    expect(row?.kind).toBe("new_request");
  });

  it("still sends a TRANSACTIONAL_EMAIL_KINDS kind to the same unsubscribed address", async () => {
    const to = "owner-suppressed-2@keepsake.ing";
    const token = await unsubscribeToken(env as unknown as Env, to);
    await SELF.fetch(`http://x/api/unsubscribe/${token}`, { method: "POST" });

    const sent = installFakeEmail();
    // "chosen" — the exact example the fix's brief names as a message that
    // must not be defeated by an unsubscribe.
    const result = await sendMail(env as unknown as Env, testMessage("chosen", to));

    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(to);
  });

  it("sends a suppressible kind normally to an address that never unsubscribed", async () => {
    const sent = installFakeEmail();
    const result = await sendMail(env as unknown as Env, testMessage("new_request", "never-unsubscribed@keepsake.ing"));
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("fails open when UNSUBSCRIBE_SECRET is unset — a misconfigured secondary system never blocks a real send", async () => {
    const to = "would-be-suppressed@keepsake.ing";
    const token = await unsubscribeToken(env as unknown as Env, to);
    await SELF.fetch(`http://x/api/unsubscribe/${token}`, { method: "POST" });
    expect(await isUnsubscribed(env as unknown as Env, to)).toBe(true);

    setTestEnvVar("UNSUBSCRIBE_SECRET", "");
    try {
      // With no secret, sendMail cannot derive this address's token at all,
      // so it cannot know this address was ever suppressed — and must not
      // pretend otherwise by refusing to send.
      expect(await isUnsubscribed(env as unknown as Env, to)).toBe(false);
      const sent = installFakeEmail();
      const result = await sendMail(env as unknown as Env, testMessage("new_request", to));
      expect(result.sent).toBe(true);
      expect(sent).toHaveLength(1);
    } finally {
      setTestEnvVar("UNSUBSCRIBE_SECRET", "test-unsubscribe-secret-do-not-use-in-any-real-environment");
    }
  });
});

describe("the footer link becomes a real URL by send time", () => {
  afterEach(() => removeFakeEmail());

  it("substitutes a real per-recipient URL into html and text, and sets List-Unsubscribe headers", async () => {
    const to = "link-check@keepsake.ing";
    const sent = installFakeEmail();
    const result = await sendMail(env as unknown as Env, testMessage("chosen", to));
    expect(result.sent).toBe(true);

    const message = sent[0] as CapturedEmail;
    const expectedUrl = await unsubscribeWebUrl(env as unknown as Env, to);
    const expectedApiUrl = await unsubscribeApiUrl(env as unknown as Env, to);
    expect(expectedUrl).toBeTruthy();

    // The raw placeholder must never reach a real inbox.
    expect(message.html).not.toContain(UNSUBSCRIBE_LINK_PLACEHOLDER);
    expect(message.text).not.toContain(UNSUBSCRIBE_LINK_PLACEHOLDER);
    expect(message.html).toContain(`href="${expectedUrl}"`);
    expect(message.text).toContain(expectedUrl as string);

    expect(message.headers?.["List-Unsubscribe"]).toContain(`<${expectedApiUrl}>`);
    expect(message.headers?.["List-Unsubscribe"]).toContain("<mailto:hello@keepsake.ing");
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("two different recipients of the same template get two different tokens", async () => {
    const sent = installFakeEmail();
    await sendMail(env as unknown as Env, testMessage("chosen", "alice-link@keepsake.ing"));
    await sendMail(env as unknown as Env, testMessage("chosen", "bob-link@keepsake.ing"));

    const aliceLink = sent[0]?.html.match(/href="([^"]+)"/)?.[1];
    const bobLink = sent[1]?.html.match(/href="([^"]+)"/)?.[1];
    expect(aliceLink).toBeTruthy();
    expect(bobLink).toBeTruthy();
    expect(aliceLink).not.toBe(bobLink);
  });

  it("falls back to a mailto: link and omits List-Unsubscribe-Post when UNSUBSCRIBE_SECRET is unset", async () => {
    setTestEnvVar("UNSUBSCRIBE_SECRET", "");
    try {
      const sent = installFakeEmail();
      await sendMail(env as unknown as Env, testMessage("chosen", "no-secret@keepsake.ing"));
      const message = sent[0] as CapturedEmail;
      expect(message.html).toContain('href="mailto:hello@keepsake.ing');
      expect(message.text).toContain("mailto:hello@keepsake.ing");
      expect(message.headers?.["List-Unsubscribe"]).toBe("<mailto:hello@keepsake.ing?subject=Unsubscribe>");
      expect(message.headers?.["List-Unsubscribe-Post"]).toBeUndefined();
    } finally {
      setTestEnvVar("UNSUBSCRIBE_SECRET", "test-unsubscribe-secret-do-not-use-in-any-real-environment");
    }
  });
});

describe("POST /api/unsubscribe/:token and POST /api/resubscribe/:token", () => {
  it("a bare GET never unsubscribes — the prefetch-safety property a mail scanner depends on", async () => {
    const to = "scanner-prefetch@keepsake.ing";
    const token = await unsubscribeToken(env as unknown as Env, to);

    // A scanner might fetch this several times; none of them may mutate.
    for (let i = 0; i < 3; i += 1) {
      const res = await SELF.fetch(`http://x/api/unsubscribe/${token}`);
      expect(res.status).toBe(200);
      const body = await readOk<{ unsubscribed: boolean }>(res);
      expect(body.unsubscribed).toBe(false);
    }

    expect(await isUnsubscribed(env as unknown as Env, to)).toBe(false);
  });

  it("round-trips: unsubscribe, verify via GET, resubscribe, verify again", async () => {
    const to = "round-trip@keepsake.ing";
    const token = await unsubscribeToken(env as unknown as Env, to);

    const before = await readOk<{ unsubscribed: boolean }>(await SELF.fetch(`http://x/api/unsubscribe/${token}`));
    expect(before.unsubscribed).toBe(false);

    const afterUnsub = await readOk<{ unsubscribed: boolean }>(
      await SELF.fetch(`http://x/api/unsubscribe/${token}`, { method: "POST" }),
    );
    expect(afterUnsub.unsubscribed).toBe(true);
    expect(await isUnsubscribed(env as unknown as Env, to)).toBe(true);

    const statusAfterUnsub = await readOk<{ unsubscribed: boolean }>(await SELF.fetch(`http://x/api/unsubscribe/${token}`));
    expect(statusAfterUnsub.unsubscribed).toBe(true);

    const afterResub = await readOk<{ unsubscribed: boolean }>(
      await SELF.fetch(`http://x/api/resubscribe/${token}`, { method: "POST" }),
    );
    expect(afterResub.unsubscribed).toBe(false);
    expect(await isUnsubscribed(env as unknown as Env, to)).toBe(false);
  });

  it("POSTing unsubscribe twice is idempotent — a one-click link fired twice by a retry or a second scanner", async () => {
    const to = "idempotent-post@keepsake.ing";
    const token = await unsubscribeToken(env as unknown as Env, to);

    const first = await SELF.fetch(`http://x/api/unsubscribe/${token}`, { method: "POST" });
    const second = await SELF.fetch(`http://x/api/unsubscribe/${token}`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await isUnsubscribed(env as unknown as Env, to)).toBe(true);
  });

  it("rejects an absurdly long token before it ever reaches D1", async () => {
    const res = await SELF.fetch(`http://x/api/unsubscribe/${"a".repeat(500)}`);
    expect(res.status).toBe(404);
  });

  it("a token nobody has ever acted on reports not-unsubscribed rather than an error", async () => {
    const res = await SELF.fetch("http://x/api/unsubscribe/never-seen-this-token-before");
    expect(res.status).toBe(200);
    const body = await readOk<{ unsubscribed: boolean }>(res);
    expect(body.unsubscribed).toBe(false);
  });
});

describe("token derivation", () => {
  it("is deterministic for the same address and different for different addresses", async () => {
    const a1 = await unsubscribeToken(env as unknown as Env, "same@keepsake.ing");
    const a2 = await unsubscribeToken(env as unknown as Env, "same@keepsake.ing");
    const b = await unsubscribeToken(env as unknown as Env, "different@keepsake.ing");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("is case- and whitespace-insensitive, matching guardRecipient's own normalization", async () => {
    const lower = await unsubscribeToken(env as unknown as Env, "case@keepsake.ing");
    const upperWithSpace = await unsubscribeToken(env as unknown as Env, "  Case@Keepsake.ING  ");
    expect(lower).toBe(upperWithSpace);
  });

  it("never appears as a bare address in either link URL", async () => {
    const url = await unsubscribeWebUrl(env as unknown as Env, "should-not-leak@keepsake.ing");
    expect(url).not.toContain("should-not-leak");
    expect(url).not.toContain(Buffer.from("should-not-leak@keepsake.ing").toString("base64"));
  });
});
