import * as React from "react";
import { View, type ViewProps, type ViewStyle } from "react-native";
import { radii, shadow } from "@keepsake/tokens/radii";
import { useColors, useContainerBorder } from "@/ui/theme";

type SurfaceProps = ViewProps & { style?: ViewStyle | ViewStyle[] };

/** An elevated container: surface fill, hairline `rule` border, paper-on-
 * paper shadow, square-ish corners. For anything that is a *thing* in the
 * feed (a listing, a photo) prefer `TagCard`, which is the same paper with
 * the hole punched. */
export function Card({ style, children, ...rest }: SurfaceProps): React.ReactElement {
  const colors = useColors();
  const border = useContainerBorder();

  const composed: ViewStyle = {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    ...border,
    // `boxShadow` renders on iOS/Android/web alike under the New Architecture —
    // see packages/tokens/src/radii.ts's header comment.
    ...({ boxShadow: shadow.card(colors.shadow) } as ViewStyle),
  };

  return (
    <View style={[composed, style]} {...rest}>
      {children}
    </View>
  );
}

/** A recessed container (skeleton blocks, inset wells). No border/shadow. */
export function Sunken({ style, children, ...rest }: SurfaceProps): React.ReactElement {
  const colors = useColors();

  const composed: ViewStyle = {
    backgroundColor: colors.surfaceSunken,
    borderRadius: radii.md,
  };

  return (
    <View style={[composed, style]} {...rest}>
      {children}
    </View>
  );
}
