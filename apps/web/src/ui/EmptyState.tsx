import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { Eyebrow } from "@/ui/Eyebrow";
import { Text } from "@/ui/Text";

export type EmptyStateProps = {
  title: string;
  line?: string;
  /** Section head above the title, e.g. "Not found". */
  eyebrow?: string;
  /** Something to sit above the words — usually the idle seal. */
  ornament?: React.ReactNode;
  action?: React.ReactNode;
};

export function EmptyState({ title, line, eyebrow, ornament, action }: EmptyStateProps): React.ReactElement {
  return (
    <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.xxxl }}>
      {ornament !== undefined ? <View style={{ marginBottom: space.sm }}>{ornament}</View> : null}
      {eyebrow !== undefined ? <Eyebrow align="center">{eyebrow}</Eyebrow> : null}
      <Text variant="displayLg" style={{ textAlign: "center", maxWidth: 560 }}>
        {title}
      </Text>
      {line !== undefined ? (
        <Text variant="bodyLg" color="textSecondary" style={{ textAlign: "center", maxWidth: 480 }}>
          {line}
        </Text>
      ) : null}
      {action !== undefined ? <View style={{ marginTop: space.md, alignItems: "center" }}>{action}</View> : null}
    </View>
  );
}
