// The explainer a first-time visitor to `keepsake.ing` sees instead of the
// feed (issue #44). `app/+html.tsx`'s pre-hydration script is what routes a
// visitor here — see that file's header comment for why the branch lives
// there (before hydration) instead of inside `index.tsx` (after it), and
// for exactly what "first-time" means. This screen's only two jobs once
// someone lands here: say what the product actually is, in plain language,
// and get out of the way to the feed. It does not re-mark "visited" itself —
// the same pre-hydration script already does that for every route, this one
// included, the moment it loads.
import * as React from "react";
import { View } from "react-native";
import { Link } from "expo-router";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Surface";
import { Stamp } from "@/ui/Stamp";

export default function Welcome(): React.ReactElement {
  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <Card style={{ gap: space.lg, alignItems: "flex-start", maxWidth: 640 }}>
        <Stamp state="idle" label="Free" />

        <Eyebrow tick>No accounts. No money.</Eyebrow>

        <Text variant="displayLg">Someone nearby has something they’re ready to let go of.</Text>

        <Text variant="bodyLg" color="textSecondary">
          They photograph it, write what it is and why it mattered, and post it here. If it’s
          yours, you ask for it — a short note, an email — and the two of you arrange to meet and
          hand it over. That’s the whole thing.
        </Text>

        <View style={{ flexDirection: "row", gap: space.xl, flexWrap: "wrap", alignItems: "center", marginTop: space.sm }}>
          <Link href="/" asChild>
            <Button label="See what's out there" />
          </Link>
          <Link href="/give" asChild>
            <Button variant="link" label="Have something to give away?" />
          </Link>
        </View>
      </Card>
    </Page>
  );
}
