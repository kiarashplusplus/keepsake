// Generic masonry layout: measures its own width (`onLayout`, not
// `useWindowDimensions` — the plan specifies *container* width breakpoints,
// which matter once this sits inside `ReadableWidth`'s capped measure rather
// than the raw viewport) and hands off the column assignment to the pure
// `assignMasonryColumns`/`groupIntoColumns` functions in `src/lib/masonry.ts`.
import * as React from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { groupIntoColumns, masonryColumnCount, verticalOffsetForId, type MasonryInput } from "@/lib/masonry";

export type MasonryGridProps<T> = {
  items: readonly T[];
  keyOf: (item: T) => string;
  sizeOf: (item: T) => { width: number; height: number };
  renderItem: (item: T) => React.ReactNode;
  gap?: number;
};

export function MasonryGrid<T>({ items, keyOf, sizeOf, renderItem, gap = space.xxl }: MasonryGridProps<T>): React.ReactElement {
  const [containerWidth, setContainerWidth] = React.useState(0);

  function handleLayout(event: LayoutChangeEvent): void {
    const width = event.nativeEvent.layout.width;
    setContainerWidth((current) => (current === width ? current : width));
  }

  const columns = masonryColumnCount(containerWidth);
  const columnWidth = containerWidth > 0 ? (containerWidth - gap * (columns - 1)) / columns : 0;

  const inputs: MasonryInput<T>[] = items.map((item) => {
    const size = sizeOf(item);
    return { key: keyOf(item), item, width: size.width, height: size.height };
  });
  const groups = groupIntoColumns(inputs, columns, columnWidth, gap);

  return (
    <View onLayout={handleLayout} style={{ flexDirection: "row", gap, alignItems: "flex-start" }} testID="masonry-grid">
      {groups.map((column, columnIndex) => (
        <View key={columnIndex} style={{ flex: 1, gap, minWidth: 0 }}>
          {column.map((item, indexInColumn) => {
            const key = keyOf(item);
            // A loose tabletop, not a grid: the first print in each column
            // gets a small deterministic vertical nudge (a print set down a
            // little higher or lower than its neighbour), derived from its
            // own id so it's stable across renders.
            const offset = indexInColumn === 0 ? verticalOffsetForId(key, 28) : 0;
            return (
              <View key={key} style={offset > 0 ? { marginTop: offset } : undefined}>
                {renderItem(item)}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
