import * as React from "react";
import { Input } from "@/ui/Input";
import type { DateFieldProps } from "@/ui/dateFieldTypes";

/**
 * Native (and any-non-DOM) fallback: the typed `YYYY-MM-DD` field this
 * replaced on the web. The real picker is `DateField.web.tsx`, which renders
 * a DOM `<input type="date">` — react-native-web's `TextInput` cannot
 * produce one (it derives the element's `type` from
 * `inputMode`/`keyboardType`/`secureTextEntry` alone and overwrites any
 * `type` prop with that), and there is no `TextInput` equivalent at all on
 * native, where this would want `@react-native-community/datetimepicker`.
 *
 * Keepsake ships web only today, so this file is the stub half of a
 * `.web.tsx` split — the same shape `PencilRule` and `KraftTable` use.
 */
export function DateField({ label, value, onChangeText, onBlur, helper, error, accessibilityHint }: DateFieldProps): React.ReactElement {
  return (
    <Input
      label={label}
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder="YYYY-MM-DD"
      helper={helper}
      error={error}
      maxLength={10}
      accessibilityHint={accessibilityHint}
    />
  );
}
