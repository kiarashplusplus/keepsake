import * as React from "react";
import { ActivityIndicator, Pressable, type PressableStateCallbackType, type ViewStyle } from "react-native";
import { radii } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Text, type TextColor } from "@/ui/Text";

/**
 * primary   — the ONE stamped rectangle filled stamp-red, print-white label.
 * secondary — the same stamped rectangle filled ink, cream label.
 * link      — the underlined typewritten line with a trailing arrow.
 * ghost     — bare typewritten text, for destructive/quiet actions.
 *
 * Every variant carries a small, fixed rotation (derived from the label so
 * it's stable across renders, not random) — a button is a stamp pressed
 * onto the page slightly off true, not a laser-cut UI control.
 *
 * **"The ONE" is per surface, and a sheet is its own surface.** Issue #224
 * read the near-black `Choose` on `/mine/:id` sitting above the stamp-red
 * `Confirm` in the sheet it opens as black outranking red in one place and
 * not in another. It is neither: red marks the single action that completes
 * what the surface in front of you is for, and an action that repeats — one
 * `Choose` per request row — can never be that action, because there is no
 * "the" about it. The giver picks a row (ink), and commits in the sheet
 * (red). Repeat the red down a list of rows and it stops meaning anything.
 *
 * There are exactly two filled ranks in the product and no third. The
 * outline button #224 also reported was never one of these variants: it was
 * `.ks-consent__btn--outline` in `public/consent.js`, which the same issue
 * removed — that banner's two answers are now identically weighted, which is
 * what #223 required of them anyway.
 */
export type ButtonVariant = "primary" | "secondary" | "link" | "ghost";

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  /**
   * Set by `<Link asChild>` — expo-router's `Slot` merges `href`, `role`
   * and the press handler onto whatever it wraps — and never by hand. With
   * it, this renders as a real `<a href>` (react-native-web makes any View
   * with an `href` an anchor) with the link role, so a "Give something" is a
   * link a crawler can follow, a middle-click can open in a new tab and a
   * screen reader announces as what it is. Without it (an `onPress`
   * action) it stays a button. Until 2026-09-09 every CTA on the site was a
   * `<div role="button">` even when it navigated, which is why nothing in
   * the served HTML of `/` linked to `/give` — the page this product
   * converts on was reachable only through the sitemap.
   *
   * Left-clicks are still routed through expo-router (`Link`'s handler
   * calls `preventDefault` and navigates in place); the anchor's own
   * navigation only runs for modifier-clicks and middle-clicks, which is
   * what those are for.
   */
  href?: string;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  /** `link` only: the trailing arrow (on by default). */
  arrow?: boolean;
  style?: ViewStyle;
};

// react-native-web's Pressable passes `hovered` (and `focused`) alongside
// `pressed`; RN's public type only declares `pressed`. Read it through a
// widened type rather than pretending hover doesn't exist on the web.
type WebPressableState = PressableStateCallbackType & { hovered?: boolean };

const MIN_HEIGHT = 44;

const TEXT_COLOR: Record<ButtonVariant, TextColor> = {
  primary: "onAccent",
  secondary: "onAccent2",
  link: "ink",
  ghost: "textSecondary",
};

/** The spinner has to sit on whatever the variant filled behind it — ink for
 * `secondary` since #134, where a `colors.ink` spinner would have been
 * invisible on its own ink fill. */
const SPINNER_COLOR = (colors: ReturnType<typeof useColors>, variant: ButtonVariant): string => {
  if (variant === "primary") return colors.onAccent;
  if (variant === "secondary") return colors.onAccent2;
  return colors.ink;
};

/** A small, stable rotation in [-1.1, 1.1] degrees, keyed off the label so
 * the same button always leans the same way rather than jittering. */
function rotationFor(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return ((Math.abs(hash) % 23) - 11) / 10;
}

export function Button({ label, onPress, href, variant = "primary", loading = false, disabled = false, arrow, style }: ButtonProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const isDisabled = disabled || loading;
  // A disabled Pressable ignores `onPress`, but a browser does not ignore an
  // anchor's `href` — so a disabled link would still navigate, as a full
  // page load. While disabled it is a plain button with nowhere to go.
  const anchorHref = isDisabled ? undefined : href;
  const showArrow = variant === "link" && arrow !== false;
  const rotateDeg = motion.reduce ? 0 : rotationFor(label);

  const containerFor = (pressed: boolean, hovered: boolean): ViewStyle => {
    const lifted = hovered && !isDisabled;
    const opacity = isDisabled ? 0.5 : pressed ? 0.85 : 1;
    const pressScale = pressed && !isDisabled ? 0.97 : 1;
    switch (variant) {
      case "primary":
        return {
          backgroundColor: colors.accent,
          paddingHorizontal: space.xl,
          borderRadius: radii.sm,
          opacity,
          transform: [{ rotate: `${rotateDeg}deg` }, { scale: pressScale }],
          ...({ boxShadow: lifted ? "3px 5px 0px rgba(27,24,21,0.35)" : "2px 3px 0px rgba(27,24,21,0.3)" } as ViewStyle),
        };
      case "secondary":
        // Issue #134. This used to fill `colors.print` (#FFFDF8) inside a 2px
        // ink outline. Against the card it sits on (`colors.surface`,
        // #FAF6EE) that fill measures 1.18:1 — for practical purposes the
        // same colour as the paper — so the button read as an empty field
        // with a line round it rather than as an action. Reported from a
        // phone about "Use my location", which is the one affordance a giver
        // has when they don't know their postcode.
        //
        // Filled ink instead, cream label: `accent2`/`onAccent2`, a pair
        // already in the tokens, so no new colour enters the system. 14.25:1
        // for the label, and the same 14.25:1 for the fill against the card,
        // so the shape is unmistakably a control. Still clearly subordinate
        // to the one stamp-red primary, which is the only thing on a page
        // wearing the accent.
        //
        // The border stays, at the fill colour: it keeps this variant's box
        // geometry identical to the outlined one it replaces.
        return {
          backgroundColor: colors.accent2,
          paddingHorizontal: space.lg,
          borderRadius: radii.sm,
          borderWidth: 2,
          borderColor: colors.accent2,
          opacity,
          transform: [{ rotate: `${rotateDeg}deg` }, { scale: pressScale }],
          // The same pressed-stamp lift the primary gets, a touch lighter.
          ...({ boxShadow: lifted ? "3px 5px 0px rgba(27,24,21,0.28)" : "2px 3px 0px rgba(27,24,21,0.22)" } as ViewStyle),
        };
      case "link":
        return {
          backgroundColor: "transparent",
          paddingHorizontal: 0,
          borderRadius: 0,
          borderBottomWidth: 2,
          borderBottomColor: lifted ? colors.accentText : colors.ink,
          opacity,
        };
      case "ghost":
        return { backgroundColor: "transparent", paddingHorizontal: space.lg, borderRadius: radii.sm, opacity };
    }
  };

  return (
    <Pressable
      accessibilityRole={anchorHref !== undefined ? "link" : "button"}
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      {...(anchorHref !== undefined ? ({ href: anchorHref } as object) : {})}
      style={(state) => {
        const { pressed, hovered = false } = state as WebPressableState;
        return [
          {
            minHeight: MIN_HEIGHT,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: space.sm,
            // Web-only transition so the hover shadow/underline eases instead of snapping.
            ...({ transitionProperty: "box-shadow, border-color, background-color, transform", transitionDuration: `${motion.liftMs}ms` } as ViewStyle),
          } as ViewStyle,
          containerFor(pressed, hovered),
          style,
        ];
      }}
    >
      {loading ? <ActivityIndicator color={SPINNER_COLOR(colors, variant)} /> : null}
      <Text variant="label" color={TEXT_COLOR[variant]} style={{ fontSize: 13 }}>
        {label}
      </Text>
      {showArrow ? (
        <Text variant="label" color={TEXT_COLOR[variant]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {"→"}
        </Text>
      ) : null}
    </Pressable>
  );
}
