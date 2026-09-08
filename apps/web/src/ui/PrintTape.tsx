// The two translucent masking-tape corners that hold a `Print` to the table.
// Extracted from `Print.tsx` so the web and native prints share one copy —
// `Print.web.tsx` renders the same tape, and a second definition of it would
// be a design detail that could drift per platform without anyone noticing.
import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { useColors } from "@/ui/theme";

/** A short strip of masking tape, rotated, at one corner. */
export function TapeCorner({ corner }: { corner: "left" | "right" }): React.ReactElement {
  const colors = useColors();
  const rotate = corner === "left" ? -18 : 14;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        top: -10,
        [corner]: 14,
        width: 44,
        height: 22,
        backgroundColor: colors.tape,
        transform: [{ rotate: `${rotate}deg` }],
        ...({ boxShadow: "0px 1px 2px rgba(0,0,0,0.12)" } as ViewStyle),
      }}
    >
      <View style={{ position: "absolute", top: 7, left: 0, right: 0, height: 1, backgroundColor: colors.tapeStripe }} />
      <View style={{ position: "absolute", top: 14, left: 0, right: 0, height: 1, backgroundColor: colors.tapeStripe }} />
    </View>
  );
}

/** Both corners, or nothing — every caller wants the pair. */
export function TapeCorners(): React.ReactElement {
  return (
    <>
      <TapeCorner corner="left" />
      <TapeCorner corner="right" />
    </>
  );
}
