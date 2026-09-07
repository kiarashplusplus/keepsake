import * as React from "react";
import { useColors } from "@/ui/theme";
import { FieldFrame, FIELD_FONT_FAMILY, FIELD_FONT_SIZE, FIELD_MIN_HEIGHT, useFieldControlLook } from "@/ui/FieldFrame";
import type { DateFieldProps } from "@/ui/dateFieldTypes";

/**
 * A real date picker (issue #133): the system wheel on iOS, the system
 * calendar on desktop, and a `YYYY-MM-DD` string out the other side — the
 * exact format `DateOfBirthSchema` already validates, so nothing downstream
 * changes. It replaced typing `1990-12-12` by hand into a numeric keypad,
 * hyphens and all.
 *
 * This is a raw DOM `<input>`, not a `TextInput`, because react-native-web's
 * `TextInput` cannot render one: it computes the element's `type` from
 * `inputMode`/`keyboardType`/`secureTextEntry` and then *overwrites* any
 * `type` prop with that computed value (`supportedProps.type = multiline ?
 * undefined : type`), so `<TextInput type="date">` silently renders a text
 * box. Mutating `ref.current.type` after mount would work today and break
 * the day react-native-web starts emitting `type="text"` — silently, and
 * back to the thing this issue was filed about. A DOM element that says what
 * it is cannot fail that way, and `test/ui/DateField.test.tsx` asserts the
 * rendered element's type.
 *
 * The label, helper/error line and the field's look come from `FieldFrame`,
 * shared with `Input`, so the picker sits on the same lined index card as
 * every other field rather than being a second look-alike.
 */
export function DateField({ label, value, onChangeText, onBlur, helper, error, min, max, accessibilityHint }: DateFieldProps): React.ReactElement {
  const colors = useColors();
  const [focused, setFocused] = React.useState(false);
  const look = useFieldControlLook({ focused, hasError: error !== undefined });

  return (
    <FieldFrame label={label} helper={helper} error={error}>
      <input
        type="date"
        aria-label={label}
        title={accessibilityHint}
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChangeText(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        style={{
          boxSizing: "border-box",
          width: "100%",
          minHeight: FIELD_MIN_HEIGHT,
          fontFamily: FIELD_FONT_FAMILY,
          fontSize: FIELD_FONT_SIZE,
          backgroundColor: look.backgroundColor,
          color: look.color,
          borderRadius: look.borderRadius,
          // `paddingHorizontal` is react-native-only; the two long-hands are
          // the same value from the same token.
          paddingLeft: look.paddingHorizontal,
          paddingRight: look.paddingHorizontal,
          borderStyle: "solid",
          borderTopWidth: 0,
          borderLeftWidth: 0,
          borderRightWidth: 0,
          borderBottomWidth: look.borderBottomWidth,
          borderBottomColor: look.borderBottomColor,
          // The baseline is the focus ring, as everywhere else in the app.
          outline: "none",
          // The paper is the same warm cream in both themes (see colors.ts),
          // so pin the browser's own picker chrome — the calendar glyph, the
          // dropdown panel — to light rather than letting a dark-mode UA
          // paint dark controls onto a light field.
          colorScheme: "light",
          // Safari refuses to fill the field's width without this and leaves
          // the value crammed against the left edge.
          display: "block",
        }}
      />
    </FieldFrame>
  );
}
