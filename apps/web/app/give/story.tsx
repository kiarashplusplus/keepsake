// Give flow — step 2 of 5: the story. A rotating gentle prompt (never a
// required structure) and a live counter against the 20-2000 char bounds.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { z } from "zod";
import { STORY_MAX, STORY_MIN } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { TextArea } from "@/ui/TextArea";
import { Button } from "@/ui/Button";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { STORY_PROMPTS, STORY_PROMPT_ROTATE_MS } from "@/features/give/storyPrompts";

const StoryFieldSchema = z
  .string()
  .trim()
  .min(STORY_MIN, `At least ${STORY_MIN} characters — enough to say what it is and why it matters.`)
  .max(STORY_MAX, `Keep it under ${STORY_MAX} characters.`);

export default function GiveStory(): React.ReactElement {
  const router = useRouter();
  const { draft, dispatch } = useGiveDraft();
  const [promptIndex, setPromptIndex] = React.useState(0);
  const [touched, setTouched] = React.useState(false);

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

        <TextArea
          label="Story"
          value={draft.story}
          onChangeText={(story) => dispatch({ type: "set_story", story })}
          onBlur={() => setTouched(true)}
          maxLength={STORY_MAX}
          minHeight={220}
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
