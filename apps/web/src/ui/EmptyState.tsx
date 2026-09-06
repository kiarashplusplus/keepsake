import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { Card } from "@/ui/Surface";
import { Eyebrow } from "@/ui/Eyebrow";
import { Text } from "@/ui/Text";

export type EmptyStateProps = {
  title: string;
  line?: string;
  /** Section head above the title, e.g. "Not found". */
  eyebrow?: string;
  /** Something to sit above the words — usually the idle stamp. */
  ornament?: React.ReactNode;
  action?: React.ReactNode;
};

/** A note card left on the table: every "nothing here"/"not found"/"taking
 * a look" moment in the product uses this, wrapped in a `Card` so its ink
 * text always reads regardless of the room's lighting (see
 * `packages/tokens/src/colors.ts`'s file header on why `ink` never sits
 * bare on the table). */
export function EmptyState({ title, line, eyebrow, ornament, action }: EmptyStateProps): React.ReactElement {
  return (
    <Card style={{ alignItems: "center", gap: space.md, paddingVertical: space.xxxl, alignSelf: "center", maxWidth: 560, width: "100%" }}>
      {ornament !== undefined ? <View style={{ marginBottom: space.sm }}>{ornament}</View> : null}
      {eyebrow !== undefined ? <Eyebrow align="center">{eyebrow}</Eyebrow> : null}
      <Text variant="displayLg" style={{ textAlign: "center", maxWidth: 480 }}>
        {title}
      </Text>
      {line !== undefined ? (
        <Text variant="bodyLg" color="textSecondary" style={{ textAlign: "center", maxWidth: 440 }}>
          {line}
        </Text>
      ) : null}
      {action !== undefined ? <View style={{ marginTop: space.md, alignItems: "center" }}>{action}</View> : null}
    </Card>
  );
}
