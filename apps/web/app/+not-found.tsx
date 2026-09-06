import * as React from "react";
import { Link } from "expo-router";
import { sectionRhythm } from "@keepsake/tokens/spacing";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { EmptyState } from "@/ui/EmptyState";
import { Button } from "@/ui/Button";
import { Stamp } from "@/ui/Stamp";

export default function NotFound(): React.ReactElement {
  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
      <EmptyState
        ornament={<Stamp state="idle" label="Not found" />}
        eyebrow="Not found"
        title="That keepsake isn’t here"
        line="It may have already found a home, or the link might be off."
        action={
          <Link href="/" asChild>
            <Button label="Back to the feed" />
          </Link>
        }
      />
    </ReadableWidth>
  );
}
