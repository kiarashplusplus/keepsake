import * as React from "react";
import { render } from "@testing-library/react-native";
import { AgeGateField, isAgeGateValid } from "@/features/ageGate/AgeGateField";

describe("isAgeGateValid", () => {
  it("accepts a date of birth well over the minimum age", () => {
    expect(isAgeGateValid("1990-01-01")).toBe(true);
  });

  it("rejects a date of birth under the minimum age", () => {
    expect(isAgeGateValid("2020-01-01")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isAgeGateValid("")).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(isAgeGateValid("01/01/1990")).toBe(false);
  });
});

describe("AgeGateField", () => {
  it("shows no error before the field is touched, even with an invalid value", () => {
    const { toJSON } = render(<AgeGateField value="" onChangeText={jest.fn()} touched={false} onBlur={jest.fn()} />);
    expect(JSON.stringify(toJSON())).not.toContain("Enter your date of birth");
  });

  it("shows the schema's own message once touched with an invalid value", () => {
    const { toJSON } = render(<AgeGateField value="not-a-date" onChangeText={jest.fn()} touched onBlur={jest.fn()} />);
    expect(JSON.stringify(toJSON())).toContain("Enter your date of birth as YYYY-MM-DD.");
  });

  it("shows the under-minimum-age message for a real but too-recent date", () => {
    const { toJSON } = render(<AgeGateField value="2020-01-01" onChangeText={jest.fn()} touched onBlur={jest.fn()} />);
    expect(JSON.stringify(toJSON())).toContain("You must be 18 or older to continue.");
  });

  it("shows no error once touched with a valid value", () => {
    const { toJSON } = render(<AgeGateField value="1990-01-01" onChangeText={jest.fn()} touched onBlur={jest.fn()} />);
    const json = JSON.stringify(toJSON());
    expect(json).not.toContain("Enter your date of birth");
    expect(json).not.toContain("You must be 18 or older");
  });

  // Guard validated by breaking it: this field's whole reason for existing
  // is that the prompt doesn't hand the user a passing answer the way the
  // old "I'm 18 or older" checkbox did. Confirmed directly — searching this
  // rendered output for that checkbox's exact former copy finds nothing.
  it("GUARD: never renders the old self-stating '18 or older' checkbox copy", () => {
    const { toJSON } = render(<AgeGateField value="1990-01-01" onChangeText={jest.fn()} touched onBlur={jest.fn()} />);
    expect(JSON.stringify(toJSON())).not.toContain("18 or older");
  });
});
