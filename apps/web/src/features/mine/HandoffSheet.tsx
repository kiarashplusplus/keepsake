// The sheet between "Choose" and the contact reveal: one note telling the
// requester where/when to pick the keepsake up.
import * as React from "react";
import { View } from "react-native";
import type { OwnerViewRequest } from "@keepsake/contracts/request";
import { space } from "@keepsake/tokens/spacing";
import { Sheet } from "@/ui/Sheet";
import { TextArea } from "@/ui/TextArea";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";

const HANDOFF_NOTE_MAX = 500;
const NOTE_PREVIEW_MAX = 96;

// A quoted opening line, not the whole note — this exists to help the giver
// recognise which of possibly several requesters they are about to shut the
// listing to, the same job the masked email next to it does, not to repeat
// the full text `RequestList` already showed them one screen up.
function previewNote(note: string): string {
  return note.length > NOTE_PREVIEW_MAX ? `${note.slice(0, NOTE_PREVIEW_MAX).trimEnd()}…` : note;
}

export type HandoffSheetProps = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (handoffNote: string) => void;
  busy: boolean;
  error: string | null;
  /** The request Choose was pressed on. Choosing closes the listing to every
   * other requester — a one-way door — so the sheet that commits it must say
   * *which* request it is about rather than trust the giver to remember
   * which row was underneath the sheet that now covers it (issue #373). */
  request: OwnerViewRequest | null;
};

export function HandoffSheet({ visible, onClose, onConfirm, busy, error, request }: HandoffSheetProps): React.ReactElement {
  const [note, setNote] = React.useState("");

  // Clears the note when the sheet closes, derived during render (React's
  // "adjusting state when a prop changes" pattern) instead of an effect —
  // see SearchBar.tsx's identical comment for why.
  const [prevVisible, setPrevVisible] = React.useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (!visible) setNote("");
  }

  const trimmedNote = note.trim();
  // The note is not a courtesy: it's the entire body of the email the chosen
  // requester gets (`apps/api/src/email/templates/chosen.ts`), and choosing
  // is irreversible. An empty note there is not a shorter message, it's a
  // blank blockquote — so Confirm stays disabled rather than letting the
  // giver commit to a handoff nobody was told anything about.
  const noteMissing = trimmedNote.length === 0;

  return (
    <Sheet visible={visible} onClose={onClose} title="Choose this request">
      <View style={{ gap: space.lg }}>
        {request !== null ? (
          <Text variant="body" color="textSecondary">
            {request.email_masked} · “{previewNote(request.note)}”
          </Text>
        ) : null}
        <TextArea
          label="Handoff note"
          value={note}
          onChangeText={setNote}
          maxLength={HANDOFF_NOTE_MAX}
          minHeight={100}
          placeholder="Where and when can they pick it up?"
          helper="They'll get this note by email the moment you confirm — it's the only thing telling them what happens next."
        />
        {error !== null ? (
          <Text variant="body" color="dangerText">
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xl }}>
          <Button label="Confirm" loading={busy} disabled={busy || noteMissing} onPress={() => onConfirm(trimmedNote)} />
          <Button label="Cancel" variant="link" arrow={false} disabled={busy} onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
