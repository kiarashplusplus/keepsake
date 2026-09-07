/**
 * Issue #64: the neutral "What is your date of birth?" prompt that replaced
 * the "I confirm I'm 18 or older" checkbox in both the give flow
 * (`app/give/review.tsx`) and the request sheet
 * (`features/request/RequestSheet.tsx`) — the two used to each carry their
 * own identical `AgeAttestationCheckbox`; this is the one shared
 * replacement instead of two copies of a more complex field.
 *
 * Why a prompt instead of a checkbox at all: a checkbox whose label states
 * its own passing answer ("I'm 18 or older" — just check it) is fine as a
 * term of service and weak as evidence. A self-selected date of birth is
 * harder to click through without noticing, which is what a neutral prompt
 * is for evidentially (Montana's willful-disregard standard, issue #61) —
 * COPPA itself doesn't require this for a general-audience service; see
 * issue #64's own research for the full reasoning.
 *
 * What is (and isn't) sent: the typed value is validated here for
 * *immediate* feedback and again by the server's identical
 * `DateOfBirthSchema` (`@keepsake/contracts/common`) — a client can't skip
 * the server-side check by editing around this component. The date of
 * birth itself is read once for its pass/fail verdict by
 * `POST /api/listings`/`POST /api/listings/:id/requests` and is never
 * written to a database column; only the resulting `age_attested_at`
 * timestamp is, exactly as the old checkbox recorded when it was checked.
 * This field never persists its value anywhere beyond the parent's
 * in-memory form state (never `sessionStorage`, unlike the rest of the give
 * draft) for the same minimal-collection reason.
 */
import * as React from "react";
import { DateOfBirthSchema } from "@keepsake/contracts/common";
import { Input } from "@/ui/Input";

export type AgeGateFieldProps = {
  value: string;
  onChangeText: (value: string) => void;
  touched: boolean;
  onBlur: () => void;
};

/** Shared with each caller's submit-button guard, so "the button is enabled"
 * and "this field shows no error" can never disagree about what counts as a
 * valid date of birth. */
export function isAgeGateValid(value: string): boolean {
  return DateOfBirthSchema.safeParse(value).success;
}

export function AgeGateField({ value, onChangeText, touched, onBlur }: AgeGateFieldProps): React.ReactElement {
  const validation = DateOfBirthSchema.safeParse(value);
  const error = touched && !validation.success ? validation.error.issues[0]?.message : undefined;

  return (
    <Input
      label="Date of birth"
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder="YYYY-MM-DD"
      helper={error === undefined ? "Not stored — only checked against our minimum age." : undefined}
      error={error}
      maxLength={10}
      accessibilityHint="Enter as year, month, day — for example 1990-05-14"
    />
  );
}
