import { describe, expect, it } from "vitest";
import { CreateReportInput, REPORT_REASONS } from "../src/report";

describe("CreateReportInput", () => {
  it("accepts a bare reason with no details", () => {
    expect(CreateReportInput.safeParse({ reason: "spam" }).success).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(CreateReportInput.safeParse({ reason: "bogus" }).success).toBe(false);
  });

  it("rejects details over 500 chars", () => {
    const result = CreateReportInput.safeParse({ reason: "other", details: "x".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("has 6 reason codes", () => {
    expect(REPORT_REASONS).toHaveLength(6);
  });
});
