import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";

export type EmptyStateProps = {
  title: string;
  line?: string;
  action?: React.ReactNode;
};

export function EmptyState({ title, line, action }: EmptyStateProps): React.ReactElement {
  return (
    <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space.xxxl }}>
      <Text variant="displayMd">{title}</Text>
      {line !== undefined ? (
        <Text variant="body" color="textSecondary" style={{ textAlign: "center" }}>
          {line}
        </Text>
      ) : null}
      {action !== undefined ? <View style={{ marginTop: space.md }}>{action}</View> : null}
    </View>
  );
}
