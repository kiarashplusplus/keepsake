import { describe, expect, it } from "vitest";
import { redactDeep, redactString } from "../src/redact";

describe("redactString", () => {
  it("redacts key=value pairs", () => {
    expect(redactString("password=hunter2")).toBe("password=[REDACTED]");
  });

  it("redacts a JSON string secret", () => {
    expect(redactString('{"token":"abc"}')).toBe('{"token":"[REDACTED]"}');
  });

  it("redacts a JSON numeric secret", () => {
    expect(redactString('{"token":123}')).toBe('{"token":[REDACTED]}');
  });

  it("redacts an Authorization bearer token", () => {
    expect(redactString("Authorization: Bearer ks_xxx")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("leaves non-sensitive text alone", () => {
    expect(redactString("hello world")).toBe("hello world");
  });
});

describe("redactDeep", () => {
  it("redacts a cf-turnstile-response key nested in an object", () => {
    const input = { form: { "cf-turnstile-response": "abc123", name: "Jane" } };
    const output = redactDeep(input) as { form: { "cf-turnstile-response": string; name: string } };
    expect(output.form["cf-turnstile-response"]).toBe("[REDACTED]");
    expect(output.form.name).toBe("Jane");
  });

  it("redacts an x-idempotency-key header nested in an object", () => {
    const input = { headers: { "x-idempotency-key": "client-generated-key-abc", accept: "application/json" } };
    const output = redactDeep(input) as { headers: { "x-idempotency-key": string; accept: string } };
    expect(output.headers["x-idempotency-key"]).toBe("[REDACTED]");
    expect(output.headers.accept).toBe("application/json");
  });

  it("redacts sensitive keys inside arrays", () => {
    const input = [{ owner_token: "ks_secret" }, { safe: "ok" }];
    const output = redactDeep(input) as Record<string, string>[];
    expect(output[0]?.owner_token).toBe("[REDACTED]");
    expect(output[1]?.safe).toBe("ok");
  });

  it("does not collapse a shared (non-cyclic) reference to [Circular]", () => {
    const shared = { name: "Jane" };
    const input = { a: shared, b: shared };
    const output = redactDeep(input) as { a: { name: string }; b: { name: string } };
    expect(output.a.name).toBe("Jane");
    expect(output.b.name).toBe("Jane");
  });

  it("still catches a genuine cycle", () => {
    const cyclic: Record<string, unknown> = { name: "Jane" };
    cyclic.self = cyclic;
    const output = redactDeep(cyclic) as { self: unknown };
    expect(output.self).toBe("[Circular]");
  });
});

/**
 * Issue #170. Before this block,
 * `grep -c "@" packages/observability/test/redact.test.ts` returned **0** —
 * the file contained no email address at all, which is why no test could ever
 * have failed on the redactor having no PII rule. Every string below is
 * either verbatim from the issue's "Evidence" section (where each one was
 * recorded as `-> unchanged`) or a deliberate must-survive control.
 *
 * The must-survive half is not decoration. A redactor is trivially made
 * "correct" by erasing everything, and an unreadable log is its own outage;
 * these pin the exact things the obvious sloppy pattern would destroy — a
 * loose digit run eating every epoch millisecond, a whole-address rule eating
 * the domain that separates "one address bounced" from "this provider refuses
 * everything" (#6).
 */
describe("redactString: personal data (#170)", () => {
  it("redacts an address in a free-text message, keeping the provider domain", () => {
    expect(redactString("sendMail failed for alice@gmail.com")).toBe(
      "sendMail failed for [REDACTED]@gmail.com",
    );
  });

  it("redacts an address in a query string the ?key= rule never covered", () => {
    expect(redactString("GET https://keepsake.ing/api/x?email=alice@gmail.com failed")).toBe(
      "GET https://keepsake.ing/api/x?email=[REDACTED]@gmail.com failed",
    );
  });

  it("redacts an address in a JSON payload under a non-sensitive key name", () => {
    expect(redactString('{"to":"alice@gmail.com","subject":"hi"}')).toBe(
      '{"to":"[REDACTED]@gmail.com","subject":"hi"}',
    );
  });

  it("redacts an address inside a stack trace", () => {
    expect(redactString("Error: bad\n at send (/src/x.ts:1:1) to=bob@yahoo.com")).toBe(
      "Error: bad\n at send (/src/x.ts:1:1) to=[REDACTED]@yahoo.com",
    );
  });

  it("redacts every address when a line names more than one", () => {
    expect(redactString("from alice@gmail.com to bob@yahoo.co.uk")).toBe(
      "from [REDACTED]@gmail.com to [REDACTED]@yahoo.co.uk",
    );
  });

  it("redacts a phone number written with separators", () => {
    expect(redactString("phone 617-555-0134 in note")).toBe("phone [REDACTED] in note");
  });

  it("redacts a phone number written with a country code or parens", () => {
    expect(redactString("call +1 617 555 0134 now")).toBe("call [REDACTED] now");
    expect(redactString("call (617) 555-0134 now")).toBe("call [REDACTED] now");
  });

  it("redacts a secret carried in a URL path segment, not just a query parameter", () => {
    // `randomTokenRaw()` is 43 base64url characters. #182 is separately moving
    // this token out of the path; this rule is defence in depth either way.
    const token = "vJ8s-Kd2Qm4pR7xW1zY6aB0cE3gH5iL9nO2qT4uX8yA";
    expect(redactString(`GET https://keepsake.ing/recover/${token} 200`)).toBe(
      "GET https://keepsake.ing/recover/[REDACTED] 200",
    );
    expect(redactString(`POST /api/recover/${token} failed`)).toBe(
      "POST /api/recover/[REDACTED] failed",
    );
    expect(redactString(`https://keepsake.ing/withdraw/${token}`)).toBe(
      "https://keepsake.ing/withdraw/[REDACTED]",
    );
  });
});

describe("redactString: what must survive redaction (#170)", () => {
  it("leaves a bare domain alone", () => {
    // `email_events.to_domain` exists precisely because a domain names a mail
    // provider, not a person. Redacting it would delete the answer to #6.
    expect(redactString("to_domain=gmail.com ok=0")).toBe("to_domain=gmail.com ok=0");
    expect(redactString("552 5.2.2 relay for gmail.com refused")).toBe(
      "552 5.2.2 relay for gmail.com refused",
    );
  });

  it("leaves a ULID alone", () => {
    expect(redactString("event 01ARZ3NDEKTSV4RRFFQ69G5FAV written")).toBe(
      "event 01ARZ3NDEKTSV4RRFFQ69G5FAV written",
    );
  });

  it("leaves epoch milliseconds alone", () => {
    // The single most common number in this Worker's logs. Moderation's own
    // phone rule matches a bare 13-digit run, which is exactly why the
    // redactor uses a stricter one.
    expect(redactString("created_at=1757260800000")).toBe("created_at=1757260800000");
  });

  it("leaves an SMTP status code and an ISO timestamp alone", () => {
    expect(redactString("552 5.2.2 mailbox full")).toBe("552 5.2.2 mailbox full");
    expect(redactString("at 2026-09-07T18:14:41.123Z")).toBe("at 2026-09-07T18:14:41.123Z");
  });

  it("leaves a short, non-secret path segment readable", () => {
    // A route file in a stack trace, not a credential.
    expect(redactString("app/withdraw/[token].tsx:12")).toBe("app/withdraw/[token].tsx:12");
  });

  it("still redacts credentials, unchanged from before", () => {
    expect(redactString("Authorization: Bearer ks_xxx")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactString("https://x/y?token=SECRET123")).toBe("https://x/y?token=[REDACTED]");
  });
});

describe("redactDeep: personal data by value shape, not key name (#170)", () => {
  it("redacts an address under a key no SENSITIVE_KEY_RE rule would match", () => {
    const input = {
      to: "alice@gmail.com",
      note: "call me at bob@x.com or 617-555-0134",
      requester_email: "c@d.com",
    };
    expect(redactDeep(input)).toEqual({
      to: "[REDACTED]@gmail.com",
      note: "call me at [REDACTED]@x.com or [REDACTED]",
      requester_email: "[REDACTED]@d.com",
    });
  });

  it("redacts an address used as an object key", () => {
    const output = redactDeep({ "alice@gmail.com": 3 }) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["[REDACTED]@gmail.com"]);
  });

  it("redacts an address nested in an array", () => {
    expect(redactDeep([{ recipient: "alice@gmail.com" }])).toEqual([
      { recipient: "[REDACTED]@gmail.com" },
    ]);
  });

  it("leaves non-PII values structurally untouched", () => {
    const input = { domain: "gmail.com", created_at: 1757260800000, ok: false };
    expect(redactDeep(input)).toEqual(input);
  });
});
