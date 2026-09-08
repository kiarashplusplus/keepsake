// Give flow — step 2 of 5: the story. A rotating gentle prompt (never a
// required structure) and a live counter against the 20-2000 char bounds.
import * as React from "react";
import { useWindowDimensions, View } from "react-native";
import { useRouter } from "expo-router";
import { z } from "zod";
import { STORY_MAX, STORY_MIN } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { type } from "@keepsake/tokens/typography";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { TextArea, TEXT_AREA_PADDING } from "@/ui/TextArea";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { useColors } from "@/ui/theme";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { coverPhoto } from "@/features/give/giveDraft";
import { STORY_PROMPTS, STORY_PROMPT_ROTATE_MS } from "@/features/give/storyPrompts";

const StoryFieldSchema = z
  .string()
  .trim()
  .min(STORY_MIN, `At least ${STORY_MIN} characters — enough to say what it is and why it matters.`)
  .max(STORY_MAX, `Keep it under ${STORY_MAX} characters.`);

/** The same 640px split the rest of the app calls narrow — see
 * `src/ui/AppHeader.tsx` and `app/index.tsx`. */
const NARROW_BREAKPOINT = 640;

/**
 * The story field's *resting* height (#217). It used to be a flat 220px in
 * both directions. On a 390x844 phone that was enough — stacked under the
 * heading, the rotating prompt, the photo-condition note, the field's own
 * label and its character counter — to push `Continue` off the bottom of the
 * step's card: what the giver actually saw was an 18px red sliver with no
 * word in it, and had to scroll to discover it was a button at all. Nothing
 * in the e2e suite could catch that, because Playwright happily clicks a
 * control that is scrolled out of view.
 *
 * Narrow is four lines of story type plus the field's own padding, so an
 * empty field still reads "write a few lines here" rather than "type a
 * subject line"; `TextArea` grows it from there the moment there is anything
 * to grow for, so the shorter rest costs a filled-in story nothing. Above
 * the breakpoint the same stack has hundreds of pixels of slack under it —
 * `Continue` was never close to the edge there — so the roomier 220px stands
 * exactly as it was rather than being tightened for a problem it doesn't
 * have.
 */
const STORY_MIN_HEIGHT_NARROW = 4 * type.bodyLg.lineHeight + 2 * TEXT_AREA_PADDING;
const STORY_MIN_HEIGHT_WIDE = 220;

export default function GiveStory(): React.ReactElement {
  const router = useRouter();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const { draft, dispatch } = useGiveDraft();
  const [promptIndex, setPromptIndex] = React.useState(0);
  const [touched, setTouched] = React.useState(false);
  const [conditionDismissed, setConditionDismissed] = React.useState(false);

  React.useEffect(() => {
    const id = setInterval(() => {
      setPromptIndex((current) => (current + 1) % STORY_PROMPTS.length);
    }, STORY_PROMPT_ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  const validation = StoryFieldSchema.safeParse(draft.story);
  const error = touched && !validation.success ? validation.error.issues[0]?.message : undefined;

  function handleContinue(): void {
    setTouched(true);
    if (!StoryFieldSchema.safeParse(draft.story).success) return;
    router.push("/give/details");
  }

  // The cover's suggested `condition` (visible wear/material/age cues) is
  // an *opener*, never a pre-fill — the story is the giver's own words, by
  // design (see the give-flow plan's Part 3). `appliedSuggestionPhotoId`
  // matching the current cover's id is what makes this decidable rather
  // than guessed: if the cover has since changed, the note simply
  // disappears rather than showing something about a different photo.
  const cover = coverPhoto(draft);
  const condition =
    cover !== null && cover.id !== null && draft.appliedSuggestionPhotoId === cover.id ? draft.suggestions[cover.id]?.condition : undefined;
  const showConditionOpener = !conditionDismissed && condition !== undefined && condition !== "";

  return (
    // See app/give/index.tsx's comment on why this step wraps itself in a
    // `Page` rather than the shell doing it once.
    <Page>
      <Card style={{ gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow>The story</Eyebrow>
          <Text variant="displayLg">Tell its story.</Text>
          <Text variant="storyExcerpt" color="textSecondary">
            {STORY_PROMPTS[promptIndex]}
          </Text>
        </View>

        {/* Issue #224. This note used to be a `Sunken` — a well filled with
            `tableEdge`, which is one of the handful of tokens that really
            does flip between light and dark (#B89D74 / #1C140F) while every
            ink colour stays constant. `textSecondary` (#635B53) on it
            measured 2.96:1 in light and 2.37:1 in dark, against AA's 4.5:1:
            the lowest-contrast text on the screen, in both themes at once,
            and the only place in the app that put words in a well at all.

            It sits on the card's own `surface` (#FAF6EE) now, marked as a
            note rather than a well by a stamp-red left rule — the same idiom
            as `public/consent.js`'s `.ks-consent__note`. `inkSoft` on
            `surface` is 10.03:1, and neither colour flips, so that number is
            the number in both themes. The rule itself is decorative: it
            carries no text and reads as an edge, not a word. */}
        {showConditionOpener ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.sm,
              paddingVertical: space.sm,
              // Logical, not `paddingLeft`/`borderLeftWidth`: the whole
              // system is written so RTL is a locale flip rather than a
              // rewrite (see docs/design/design-system.md).
              paddingStart: space.md,
              borderStartWidth: 2,
              borderStartColor: colors.accent,
            }}
          >
            <Text variant="body" color="inkSoft" style={{ flex: 1 }}>
              Your photo shows {condition}. Worth a line?
            </Text>
            <IconButton icon="close" label="Dismiss" size={16} onPress={() => setConditionDismissed(true)} />
          </View>
        ) : null}

        <TextArea
          label="Story"
          value={draft.story}
          onChangeText={(story) => dispatch({ type: "set_story", story })}
          onBlur={() => setTouched(true)}
          maxLength={STORY_MAX}
          minHeight={width < NARROW_BREAKPOINT ? STORY_MIN_HEIGHT_NARROW : STORY_MIN_HEIGHT_WIDE}
          error={error}
          placeholder="My grandmother's hands made this cup every morning for forty years…"
        />

        <View style={{ flexDirection: "row" }}>
          <Button label="Continue" onPress={handleContinue} />
        </View>
      </Card>
    </Page>
  );
}
