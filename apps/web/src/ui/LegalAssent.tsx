import * as React from "react";
import { Text } from "@/ui/Text";

/**
 * The line that puts the Terms in front of someone at the moment they agree
 * to them.
 *
 * WHY THIS EXISTS
 *
 * `apps/site/public/terms.html` carries a one-way indemnification clause: a
 * giver covers Keepsake for claims arising from the handoff, expressly
 * including a claim that Keepsake was itself negligent. That clause is boxed
 * and bolded for a reason — Texas's fair-notice doctrine has two halves, and
 * conspicuousness is one of them (see the `.indemnity` style and the comment
 * beside the clause, recording issue #63).
 *
 * The other half is that the person actually had the terms put to them. Until
 * this component, nothing in the give flow, the request sheet or the age gate
 * referenced `/terms` at all — the only route to it was the persistent
 * `AppFooter`. A clause that stands out inside a document nobody was shown is
 * the weaker half of the doctrine doing all the work alone.
 *
 * Deliberately NOT a checkbox. The same reasoning as issue #64's age gate: a
 * box whose label states its own passing answer is weak evidence, and this
 * screen is the most important one in the funnel. A visible sentence at the
 * point of action is the honest version.
 *
 * The giver's line names the indemnity specifically rather than pointing at
 * "the Terms" generically, because the specific obligation is the one a
 * reasonable person would want flagged. A requester is not subject to that
 * clause, so their line does not claim they are.
 *
 * `/terms` and `/privacy` are static pages from `apps/site`, NOT expo-router
 * routes — so these are plain anchors (`accessibilityRole="link"` + `href`,
 * which react-native-web renders as `<a>`), the same pattern `AppFooter` and
 * `AppHeader`'s `SiteLink` use. An expo-router `<Link>` would try to resolve
 * a route that does not exist in the app's route tree.
 */
export type LegalAssentAction = "give" | "request";

function SiteLink({ href, label }: { href: string; label: string }): React.ReactElement {
  return (
    <Text
      accessibilityRole="link"
      color="accentText"
      variant="caption"
      style={{ textDecorationLine: "underline" }}
      {...({ href } as object)}
    >
      {label}
    </Text>
  );
}

export function LegalAssent({ action }: { action: LegalAssentAction }): React.ReactElement {
  if (action === "give") {
    return (
      <Text variant="caption" color="textSecondary">
        By giving this away you agree to the <SiteLink href="/terms" label="Terms" />, including the part where you
        cover Keepsake for what happens between you and the person you give it to. Your date of birth is checked
        against our minimum age and then discarded — the <SiteLink href="/privacy" label="Privacy" /> page explains
        what we keep.
      </Text>
    );
  }
  return (
    <Text variant="caption" color="textSecondary">
      By sending this you agree to the <SiteLink href="/terms" label="Terms" />. Your note, email and phone number go
      to the giver only if they choose you, and the confirmation email we send has a link that erases them — see{" "}
      <SiteLink href="/privacy" label="Privacy" />.
    </Text>
  );
}
