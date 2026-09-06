import * as React from "react";
import { View, type ViewProps, type ViewStyle } from "react-native";
import { radii, shadow } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";

type SurfaceProps = ViewProps & { style?: ViewStyle | ViewStyle[] };

/**
 * A sheet of paper resting on the table: the constant, kraft-tinted `surface`
 * fill, a hairline INNER edge (not a border — see the file header comment
 * on `radii.ts`), and a shadow offset down-and-right. This is the wrapper
 * every screen's prose/forms/dashboard rows sit inside, so body copy never
 * has to be read directly off the table (which, in dark mode, is a night
 * colour that plain ink can't sit on — see `packages/tokens/src/colors.ts`'s
 * file header). Square corners, no pill, no hairline box.
 */
export function Card({ style, children, ...rest }: SurfaceProps): React.ReactElement {
  const colors = useColors();

  const composed: ViewStyle = {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: space.xl,
    ...({
      boxShadow: `inset 0px 0px 0px 1px rgba(0,0,0,0.08), ${shadow.card(colors.shadow)}`,
    } as ViewStyle),
  };

  return (
    <View style={[composed, style]} {...rest}>
      {children}
    </View>
  );
}

/** A recessed well cut into a `Card` (skeleton blocks, inset wells). */
export function Sunken({ style, children, ...rest }: SurfaceProps): React.ReactElement {
  const colors = useColors();

  const composed: ViewStyle = {
    backgroundColor: colors.tableEdge,
    borderRadius: radii.md,
  };

  return (
    <View style={[composed, style]} {...rest}>
      {children}
    </View>
  );
}
