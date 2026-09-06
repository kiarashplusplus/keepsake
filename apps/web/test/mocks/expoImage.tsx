/**
 * Jest-only stand-in for `expo-image`, wired via `jest.config.js`'s
 * `moduleNameMapper`. The real package's entry point pulls in
 * `expo-modules-core` (native module registration, `import`/ESM all the way
 * down), which Jest's jsdom environment can't execute even after adding the
 * package to `transformIgnorePatterns` — mounting a real `<Image>` isn't the
 * point of any of this repo's tests, only that a listing photo's props
 * (source/placeholder/accessibilityLabel) made it through. A plain `View`
 * with those same props spread on keeps every render test that mounts
 * `ListingCard`/`PhotoCarousel`/the dashboard rows working without the
 * native dependency chain.
 */
import * as React from "react";
import { View, type ViewProps } from "react-native";

export type ImageProps = ViewProps & {
  source?: unknown;
  placeholder?: unknown;
  contentFit?: string;
  transition?: number;
  accessibilityLabel?: string;
};

export function Image({ source: _source, placeholder: _placeholder, contentFit: _contentFit, transition: _transition, ...rest }: ImageProps): React.ReactElement {
  return <View {...rest} />;
}

export default { Image };
