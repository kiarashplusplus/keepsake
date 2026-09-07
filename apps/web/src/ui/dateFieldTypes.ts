/**
 * `DateField`'s props, in their own module so the `.web.tsx` implementation
 * and the native stub share one declaration instead of two that can drift.
 * (A type-only import from either implementation would resolve to whichever
 * platform variant the bundler picked, which is exactly the drift this
 * avoids.)
 */
export type DateFieldProps = {
  label: string;
  /** `YYYY-MM-DD`, or `""` for empty — the same string `DateOfBirthSchema`
   * validates, on every platform. The control only changes how a person
   * produces it. */
  value: string;
  onChangeText: (value: string) => void;
  onBlur?: () => void;
  helper?: string | undefined;
  error?: string | undefined;
  /** Earliest selectable date, `YYYY-MM-DD`. */
  min?: string | undefined;
  /** Latest selectable date, `YYYY-MM-DD`. */
  max?: string | undefined;
  accessibilityHint?: string | undefined;
};
