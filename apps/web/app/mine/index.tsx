// M1: replace with the real dashboard (Reviewing / Live / Needs attention /
// Given / Withdrawn grouping, email card, "Lost your listings?" recovery
// link) — see the build plan's "Web app" section.
import * as React from "react";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { EmptyState } from "@/ui/EmptyState";

export default function Mine(): React.ReactElement {
  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: 64 }}>
      <EmptyState
        title="Nothing here yet"
        line="Once you give something, it'll show up here so you can follow along."
      />
    </ReadableWidth>
  );
}
