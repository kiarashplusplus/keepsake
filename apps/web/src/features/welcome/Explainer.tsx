// The explainer a first-time visitor to `keepsake.ing` sees instead of the
// feed (issue #44), and the whole of `/welcome`. One component, two homes:
//
//  - `app/index.tsx` renders it into `/` alongside the feed, and the shell's
//    stylesheet shows this one to a device that has never been here and the
//    feed to everyone else (`src/lib/firstVisit.ts` says how, and why that
//    replaced a redirect to `/welcome`). There, "See what's out there" is a
//    button that switches to the feed in place — the visitor is already at
//    `/`, and a link to `/` from `/` would be a full reload of the page they
//    are on.
//  - `app/welcome.tsx` renders it as a page of its own, with a `RouteHead`
//    and "See what's out there" as a real link to `/`.
//
// It is content, not a page: a `ReadableWidth`, not a `Page`. Both homes
// put it inside their own `Page`, and on `/` that one `Page` holds the feed
// too — one scroller, one footer, whichever screen is showing. (Two `Page`s
// meant two footers in the document, and every "About"/"Privacy choices"
// locator in the suite resolved to both.)
//
// Its only two jobs: say what the product actually is, in plain language,
// and get out of the way. It does not mark "visited" itself — the
// pre-hydration script in `app/+html.tsx` already does that on every page
// load, this one included.
import * as React from "react";
import { View } from "react-native";
import { Link } from "expo-router";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Surface";
import { Stamp } from "@/ui/Stamp";

export type ExplainerProps = {
  /**
   * What "See what's out there" does. Given, the button calls it (the feed
   * is on this same page, hidden); omitted, the button is a link to `/`.
   */
  onBrowse?: () => void;
};

export function Explainer({ onBrowse }: ExplainerProps): React.ReactElement {
  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
      <Card style={{ gap: space.lg, alignItems: "flex-start", maxWidth: 640 }}>
        <Stamp state="idle" label="Free" />

        <Eyebrow tick>No passwords. No money.</Eyebrow>

        <Text variant="displayLg">Someone nearby has something they’re ready to let go of.</Text>

        <Text variant="bodyLg" color="textSecondary">
          They photograph it, write what it is and why it mattered, and post it here. If it’s yours,
          you ask for it — a short note, an email — and the two of you arrange to meet and hand it
          over. That’s the whole thing.
        </Text>

        <View
          style={{
            flexDirection: "row",
            gap: space.xl,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: space.sm,
          }}
        >
          {onBrowse !== undefined ? (
            <Button label="See what's out there" onPress={onBrowse} />
          ) : (
            <Link href="/" asChild>
              <Button label="See what's out there" />
            </Link>
          )}
          {/* `dangerouslySingular` — see `AppHeader`'s Give link. */}
          <Link href="/give" dangerouslySingular asChild>
            <Button variant="link" label="Have something to give away?" />
          </Link>
        </View>
      </Card>
    </ReadableWidth>
  );
}
