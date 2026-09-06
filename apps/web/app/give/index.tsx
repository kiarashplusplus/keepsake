// M1: replace with the 5-step give flow (photos, story, details, email,
// review) — see the build plan's "Web app" section for the step shell,
// GiveDraft context, resize/blurhash upload, and the breathing-seal
// reviewing state.
import * as React from "react";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { EmptyState } from "@/ui/EmptyState";

export default function Give(): React.ReactElement {
  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: 64 }}>
      <EmptyState
        title="Giving isn't wired up yet"
        line="The photo, story and details steps land in M1."
      />
    </ReadableWidth>
  );
}
