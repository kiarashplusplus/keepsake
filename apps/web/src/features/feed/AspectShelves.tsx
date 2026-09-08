// Issue #39: shelves grouping the current feed's common aspect values —
// "Copper", "1970s" — as rows of small taped prints sitting directly on the
// table, above the full masonry grid. Deliberately not a filter UI (no
// "browse by Copper" link that replaces the grid below): each print here
// links straight to its item page, same as any card in the main grid, and
// the full grid always renders underneath regardless of what's here — see
// `app/index.tsx` and issue #40. Renders nothing (no heading, no empty
// rail) when `shelves` is empty, so a catalogue too small for any aspect
// value to clear the floor degrades to exactly the plain feed, not a
// half-empty "Shelves" section.
import * as React from "react";
import { ScrollView, View } from "react-native";
import type { AspectShelf } from "@keepsake/contracts/shelves";
import { space } from "@keepsake/tokens/spacing";
import { TableHeading } from "@/ui/TableHeading";
import { ListingCard } from "@/features/feed/ListingCard";

const SHELF_ITEM_WIDTH = 200;

function pieceWord(count: number): string {
  return count === 1 ? "piece" : "pieces";
}

function Shelf({ shelf }: { shelf: AspectShelf }): React.ReactElement {
  return (
    <View style={{ gap: space.md }} testID={`shelf-${shelf.name}-${shelf.value}`}>
      {/* Issue #216: the shelf's name and its count used to be a bare
          `Eyebrow` plus a caption laid straight on the table, which is the
          one thing `packages/tokens/src/colors.ts` says nothing does — both
          colours are constant, so on the dark table they measured 1.12:1 and
          2.60:1. Same words, same order, now printed on a paper strip like
          the rest of the shelves' contents. */}
      <TableHeading note={`${shelf.count} ${pieceWord(shelf.count)} on the table`}>{shelf.value}</TableHeading>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.lg, paddingBottom: space.sm, paddingEnd: space.sm }}>
        {shelf.items.map((listing) => (
          <View key={listing.id} style={{ width: SHELF_ITEM_WIDTH }}>
            <ListingCard listing={listing} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

export function AspectShelves({ shelves }: { shelves: AspectShelf[] }): React.ReactElement | null {
  if (shelves.length === 0) return null;
  return (
    <View style={{ gap: space.xxl }} testID="aspect-shelves">
      {shelves.map((shelf) => (
        <Shelf key={`${shelf.name}:${shelf.value}`} shelf={shelf} />
      ))}
    </View>
  );
}
