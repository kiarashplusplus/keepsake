import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The recipient guard in `src/email/sendMail.ts` is only as good as the
 * configuration behind it, and that config lives in a file no other test
 * reads. `EMAIL_MODE = "test"` disables the guard entirely — it exists for the
 * unit suite's `@example.com` fixtures against a fake binding. If it ever
 * lands in wrangler.toml, a real environment starts mailing addresses that are
 * guaranteed to bounce, and Cloudflare scores the sending domain on that.
 */
const wrangler = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;

function emailModes(): string[] {
  return [...wrangler.matchAll(/^EMAIL_MODE\s*=\s*"([^"]*)"/gm)].map((m) => m[1] ?? "");
}

describe("EMAIL_MODE configuration", () => {
  it("never enables the test escape hatch in real config", () => {
    expect(emailModes()).not.toContain("test");
  });

  it("declares a mode for every environment, and only known modes", () => {
    const modes = emailModes();
    // local, preview, production.
    expect(modes).toHaveLength(3);
    for (const mode of modes) expect(["off", "allowlist", "live"]).toContain(mode);
  });

  it("keeps preview on an allowlist with at least one address", () => {
    // Anchored to line starts: `[env.preview]` also appears inside a comment
    // higher up the file, and slicing from that match silently produced an
    // empty section that matched nothing.
    const start = /^\[env\.preview\]/m.exec(wrangler)?.index ?? -1;
    const end = /^\[env\.production\]/m.exec(wrangler)?.index ?? -1;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const preview = wrangler.slice(start, end);
    expect(preview).toMatch(/EMAIL_MODE\s*=\s*"allowlist"/);
    const allowlist = /EMAIL_ALLOWLIST\s*=\s*"([^"]*)"/.exec(preview)?.[1] ?? "";
    expect(allowlist.split(",").filter((a) => a.trim().length > 0).length).toBeGreaterThan(0);
  });
});
