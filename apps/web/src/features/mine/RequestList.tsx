// The dashboard detail's request list: one row per `OwnerViewRequest`, with
// the chosen one's real contact revealed (copy buttons + a `mailto:` link)
// and every other row reading "Not chosen" once a choice has been made.
import * as React from "react";
import { StyleSheet, View } from "react-native";
import type { OwnerViewRequest, RequestStatus } from "@keepsake/contracts/request";
import { space } from "@keepsake/tokens/spacing";
import { Text, type TextColor } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { useColors } from "@/ui/theme";
import { useToast } from "@/ui/Toast";
import { relativeTime } from "@/lib/relativeTime";

const STATUS_LABELS: Record<RequestStatus, { label: string; color: TextColor }> = {
  open: { label: "Open", color: "textSecondary" },
  chosen: { label: "Chosen", color: "accent2Text" },
  not_chosen: { label: "Not chosen", color: "textTertiary" },
  withdrawn: { label: "Withdrawn", color: "textTertiary" },
  // Set by POST /api/admin/requests/:id/remove — distinct from a requester's
  // own `withdrawn`, since it wasn't their action. `request.note` already
  // reads `ADMIN_REMOVED_REQUEST_PLACEHOLDER` in this state.
  removed: { label: "Removed", color: "textTertiary" },
};

async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function ContactRow({ request }: { request: OwnerViewRequest }): React.ReactElement {
  const toast = useToast();

  async function handleCopy(value: string): Promise<void> {
    const copied = await copyToClipboard(value);
    toast.show(copied ? "Copied." : "Couldn't copy — select the text instead.");
  }

  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <Text variant="body">{request.email}</Text>
        <Button label="Copy" variant="link" arrow={false} onPress={() => void handleCopy(request.email ?? "")} />
        <Button
          label="Email"
          variant="link"
          arrow={false}
          onPress={() => {
            if (typeof window !== "undefined" && request.email !== undefined) window.location.assign(`mailto:${request.email}`);
          }}
        />
      </View>
      {request.phone !== undefined ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Text variant="body">{request.phone}</Text>
          <Button label="Copy" variant="link" arrow={false} onPress={() => void handleCopy(request.phone ?? "")} />
        </View>
      ) : null}
    </View>
  );
}

export type RequestRowProps = {
  request: OwnerViewRequest;
  canChoose: boolean;
  busy: boolean;
  onChoose: (requestId: string) => void;
};

function RequestRow({ request, canChoose, busy, onChoose }: RequestRowProps): React.ReactElement {
  const colors = useColors();
  const status = STATUS_LABELS[request.status];

  return (
    <View style={{ gap: space.sm, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.rule }}>
      <Text variant="bodyLg" color="inkSoft">
        {request.note}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <Text variant="caption" color="textTertiary">
          {request.email_masked}
          {request.phone_masked !== undefined ? ` · ${request.phone_masked}` : ""} · {relativeTime(request.created_at)}
        </Text>
        <Text variant="eyebrow" color={status.color} style={{ fontSize: 11, lineHeight: 14 }}>
          {status.label}
        </Text>
      </View>

      {request.notify_failed && request.status === "open" ? (
        <Text variant="body" color="dangerText">
          {"We couldn't reach you about this one — check the email address on your dashboard so the next note doesn't miss you too."}
        </Text>
      ) : null}

      {request.status === "chosen" ? <ContactRow request={request} /> : null}

      {request.notify_failed && request.status === "chosen" ? (
        <Text variant="body" color="dangerText">
          {"We couldn't reach them to say you chose them — worth a note yourself, using what's above."}
        </Text>
      ) : null}

      {canChoose && request.status === "open" ? (
        <View style={{ flexDirection: "row" }}>
          <Button label="Choose" variant="secondary" disabled={busy} onPress={() => onChoose(request.id)} />
        </View>
      ) : null}
    </View>
  );
}

export type RequestListProps = {
  requests: readonly OwnerViewRequest[];
  /** Whether any request can still be chosen (the listing has none chosen
   * yet and is still live). */
  canChoose: boolean;
  busy: boolean;
  onChoose: (requestId: string) => void;
};

export function RequestList({ requests, canChoose, busy, onChoose }: RequestListProps): React.ReactElement {
  if (requests.length === 0) {
    return (
      <Text variant="body" color="textSecondary">
        No one has asked yet. Share the link.
      </Text>
    );
  }

  return (
    <View>
      {requests.map((request) => (
        <RequestRow key={request.id} request={request} canChoose={canChoose} busy={busy} onChoose={onChoose} />
      ))}
    </View>
  );
}
