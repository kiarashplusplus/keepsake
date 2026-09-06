// The sheet between "Choose" and the contact reveal: one optional note
// telling the requester where/when to pick the keepsake up.
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { Sheet } from "@/ui/Sheet";
import { TextArea } from "@/ui/TextArea";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";

const HANDOFF_NOTE_MAX = 500;

export type HandoffSheetProps = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (handoffNote: string) => void;
  busy: boolean;
  error: string | null;
};

export function HandoffSheet({ visible, onClose, onConfirm, busy, error }: HandoffSheetProps): React.ReactElement {
  const [note, setNote] = React.useState("");

  // Clears the note when the sheet closes, derived during render (React's
  // "adjusting state when a prop changes" pattern) instead of an effect —
  // see SearchBar.tsx's identical comment for why.
  const [prevVisible, setPrevVisible] = React.useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (!visible) setNote("");
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Choose this request">
      <View style={{ gap: space.lg }}>
        <TextArea
          label="Handoff note"
          value={note}
          onChangeText={setNote}
          maxLength={HANDOFF_NOTE_MAX}
          minHeight={100}
          placeholder="Where and when can they pick it up?"
        />
        {error !== null ? (
          <Text variant="body" color="dangerText">
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xl }}>
          <Button label="Confirm" loading={busy} disabled={busy} onPress={() => onConfirm(note.trim())} />
          <Button label="Cancel" variant="link" arrow={false} disabled={busy} onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
