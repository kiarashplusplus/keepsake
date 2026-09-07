import { afterEach, describe, expect, it, vi } from "vitest";
import { captureException, captureMessage, configureCapture } from "../src/capture";

afterEach(() => {
  vi.restoreAllMocks();
  configureCapture({ service: "unknown", environment: "development" });
});

describe("captureException", () => {
  it("emits exactly one structured console.error line, not a string", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    captureException(new Error("boom"));

    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] ?? [];
    expect(typeof line).toBe("object");
    expect(line).not.toBeNull();
    const record = line as Record<string, unknown>;
    expect(record.event).toBe("capture");
    expect(record.level).toBe("error");
    expect((record.error as { name: string; message: string }).name).toBe("Error");
    expect((record.error as { name: string; message: string }).message).toBe("boom");
  });

  it("stamps service/environment/release from configureCapture", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureCapture({ service: "keepsake-api", environment: "production", release: "abc123" });
    captureException(new Error("boom"));

    const record = (spy.mock.calls[0] ?? [])[0] as Record<string, unknown>;
    expect(record.service).toBe("keepsake-api");
    expect(record.environment).toBe("production");
    expect(record.release).toBe("abc123");
  });

  it("redacts a secret-looking value in extra", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    captureException(new Error("boom"), { extra: { owner_token: "ks_super_secret_value" } });

    const record = (spy.mock.calls[0] ?? [])[0] as { extra: Record<string, unknown> };
    expect(record.extra.owner_token).toBe("[REDACTED]");
  });

  it("redacts an Authorization header baked into the error message/stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = new Error("failed to fetch: Authorization: Bearer ks_realtoken_value");
    err.stack = "Error: Authorization: Bearer ks_realtoken_value\n  at somewhere";
    captureException(err);

    const record = (spy.mock.calls[0] ?? [])[0] as { error: { message: string; stack?: string } };
    expect(record.error.message).toContain("[REDACTED]");
    expect(record.error.message).not.toContain("ks_realtoken_value");
    expect(record.error.stack).toContain("[REDACTED]");
    expect(record.error.stack).not.toContain("ks_realtoken_value");
  });

  it("preserves tags alongside redacted extra", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    captureException(new Error("cron exploded"), { tags: { cron: "moderationRetry" }, extra: { listingId: "abc" } });

    const record = (spy.mock.calls[0] ?? [])[0] as { tags: Record<string, unknown>; extra: Record<string, unknown> };
    expect(record.tags.cron).toBe("moderationRetry");
    expect(record.extra.listingId).toBe("abc");
  });

  it("never throws on a circular-reference extra object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => captureException(new Error("boom"), { extra: circular })).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never throws on an object with a throwing getter, in extra or as the error itself", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = {
      get owner_token(): string {
        throw new Error("getter exploded");
      },
    };

    expect(() => captureException(new Error("boom"), { extra: hostile })).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();

    const hostileError = {
      get message(): string {
        throw new Error("message getter exploded");
      },
    };
    expect(() => captureException(hostileError)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("captureMessage", () => {
  it("logs a warning through console.warn, not console.error", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    captureMessage("Moderation budget exhausted for mod_image today", "warning");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    const record = (warnSpy.mock.calls[0] ?? [])[0] as Record<string, unknown>;
    expect(record.event).toBe("capture");
    expect(record.level).toBe("warning");
    expect(record.message).toBe("Moderation budget exhausted for mod_image today");
  });

  it("logs an error-level message through console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    captureMessage("something bad", "error");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("redacts the message itself when it contains a secret-shaped substring", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    captureMessage("login failed password=hunter2", "warning");
    const record = (warnSpy.mock.calls[0] ?? [])[0] as { message: string };
    expect(record.message).toBe("login failed password=[REDACTED]");
  });

  it("never throws on a circular extra object", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => captureMessage("boom", "warning", { extra: circular })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
