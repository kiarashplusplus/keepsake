/**
 * The one sheet behind Hide/Reject/Ban: free-text (optional) for Hide and
 * Ban, an enum picker (required — `ADMIN_REJECT_REASONS`, the giver-facing
 * subset of `MODERATION_REASON_CODES`) for Reject. A single component
 * rather than three near-identical ones, discriminated on `mode` so each
 * caller's prop shape only ever has to supply what that mode actually needs.
 *
 * `mode: "confirm"` is the fourth shape, added for bulk actions
 * (`app/admin.tsx`'s `handleBulkConfirm`): no input, just a yes/no on a
 * message that names exactly how many rows are about to move — the count a
 * destructive bulk action has to state before it fires (issue #11).
 */
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { TextArea } from "@/ui/TextArea";
import { Chip } from "@/ui/Chip";
import { Button } from "@/ui/Button";
import { Eyebrow } from "@/ui/Eyebrow";

type BaseProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
};

export type ReasonSheetProps =
  | (BaseProps & { mode: "text"; onConfirm: (reason: string | undefined) => void })
  | (BaseProps & {
      mode: "enum";
      /**
       * `label` is what the chip says and has to fit one: two or three
       * words. `detail` is the longer sentence the choice actually sends
       * (for Reject, the giver-facing `MODERATION_REASONS` copy) and is
       * shown under the row once that option is picked — so the moderator
       * still reads exactly what will go out, without the chips having to
       * carry it and run off the sheet at every width (#354).
       */
      options: readonly { value: string; label: string; detail?: string }[];
      onConfirm: (reason: string) => void;
    })
  | (BaseProps & { mode: "confirm"; message: string; onConfirm: () => void });

export function ReasonSheet(props: ReasonSheetProps): React.ReactElement {
  const [text, setText] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  // Reset the fields the moment `visible` flips to false — whether that's
  // the Cancel button (this file) or the parent closing the sheet after a
  // successful confirm (`app/admin.tsx` sets its `sheet` state to `null`,
  // which only ever changes this prop, not the mounted instance). A render-
  // phase comparison against the previous prop, not an effect: React's own
  // "adjusting state when a prop changes" pattern, since a `useEffect` here
  // would fire setState synchronously on every close and this repo's lint
  // config (react-hooks' `set-state-in-effect`) treats that as a bug smell.
  const [wasVisible, setWasVisible] = React.useState(props.visible);
  if (props.visible !== wasVisible) {
    setWasVisible(props.visible);
    if (!props.visible) {
      setText("");
      setSelected(null);
    }
  }

  function handleConfirm(): void {
    if (props.mode === "text") {
      props.onConfirm(text.trim() === "" ? undefined : text.trim());
      return;
    }
    if (props.mode === "confirm") {
      props.onConfirm();
      return;
    }
    if (selected !== null) props.onConfirm(selected);
  }

  const canConfirm = props.mode === "text" || props.mode === "confirm" || selected !== null;

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={props.title}>
      <View style={{ gap: space.lg }}>
        {props.mode === "text" ? (
          <TextArea
            label="Reason (optional)"
            value={text}
            onChangeText={setText}
            maxLength={500}
            minHeight={80}
          />
        ) : props.mode === "confirm" ? (
          <Text variant="body" color="inkSoft">
            {props.message}
          </Text>
        ) : (
          <View style={{ gap: space.md }}>
            <View
              accessibilityRole="radiogroup"
              style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}
            >
              {props.options.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  selected={selected === option.value}
                  onPress={() => setSelected(option.value)}
                />
              ))}
            </View>
            <SelectedDetail options={props.options} selected={selected} />
          </View>
        )}
        {props.error !== null ? (
          <Text variant="body" color="dangerText">
            {props.error}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Button
            label={props.confirmLabel}
            loading={props.busy}
            disabled={props.busy || !canConfirm}
            onPress={handleConfirm}
          />
          <Button label="Cancel" variant="link" arrow={false} onPress={props.onClose} />
        </View>
      </View>
    </Sheet>
  );
}

/**
 * The sentence behind the selected chip, or — before anything is picked — a
 * line saying one is coming, so the space it takes doesn't appear from
 * nowhere on the first tap. Only ever rendered when at least one option
 * carries a `detail`: a picker whose labels are the whole story (none today,
 * but the prop is optional) shows nothing extra.
 */
function SelectedDetail({
  options,
  selected,
}: {
  options: readonly { value: string; label: string; detail?: string }[];
  selected: string | null;
}): React.ReactElement | null {
  if (!options.some((option) => option.detail !== undefined)) return null;
  const detail = options.find((option) => option.value === selected)?.detail;
  return (
    <View style={{ gap: space.xxs }}>
      <Eyebrow>The giver will read</Eyebrow>
      {detail !== undefined ? (
        <Text variant="body" color="inkSoft">
          {detail}
        </Text>
      ) : (
        <Text variant="caption" color="textTertiary">
          Pick a reason to see the sentence it sends.
        </Text>
      )}
    </View>
  );
}
