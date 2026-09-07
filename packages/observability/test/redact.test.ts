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
