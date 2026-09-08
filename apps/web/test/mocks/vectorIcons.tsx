/**
 * Jest-only stand-in for `@expo/vector-icons`, wired via `jest.config.js`'s
 * `moduleNameMapper` — the same approach `expoImage.tsx`'s header explains
 * for the same reason: the real package's `Ionicons` pulls in `expo-font`
 * and, behind it, `expo-asset`'s ESM build, neither of which Jest's jsdom
 * environment can execute even once added to `transformIgnorePatterns` (it
 * doesn't stop there — `expo-asset` pulls in more). Mounting a real glyph
 * isn't the point of any test that renders `IconButton`/`AppHeader`, only
 * that the `name`/`color`/`size` props reached *something*. A plain `Text`
 * carrying the icon name as its content keeps `getByText`/snapshot-style
 * assertions meaningful without the native font-loading chain.
 */
import * as React from "react";
import { Text, type TextProps } from "react-native";

export type IconProps = TextProps & {
  name?: string;
  size?: number;
  color?: string;
};

function makeIconStub(): React.ComponentType<IconProps> {
  return function IconStub({ name, size: _size, color: _color, ...rest }: IconProps): React.ReactElement {
    return (
      <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...rest}>
        {name ?? ""}
      </Text>
    );
  };
}

export const Ionicons = makeIconStub();
export const AntDesign = makeIconStub();
export const MaterialIcons = makeIconStub();
export const FontAwesome = makeIconStub();
