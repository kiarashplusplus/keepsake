import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { measure } from "@keepsake/tokens/spacing";
import { space } from "@keepsake/tokens/spacing";

export type ReadableWidthProps = {
  variant: "prose" | "grid";
  children: React.ReactNode;
  style?: ViewStyle;
};

/** Centers content under a content measure: 720px prose, 1100px grid. */
export function ReadableWidth({ variant, children, style }: ReadableWidthProps): React.ReactElement {
  const maxWidth = variant === "prose" ? measure.prose : measure.grid;

  return (
    <View
      style={[
        {
          width: "100%",
          maxWidth,
          alignSelf: "center",
          paddingHorizontal: space.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
