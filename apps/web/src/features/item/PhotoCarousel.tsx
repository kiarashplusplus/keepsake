// Full-size photo carousel for the item page: horizontal paging ScrollView
// with dots, `expo-image` at `url_full` with a blurhash placeholder so the
// first paint is never a blank box.
import * as React from "react";
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Image as ExpoImage } from "expo-image";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Print } from "@/ui/Print";

export type PhotoCarouselProps = {
  photos: readonly PublicPhoto[];
  /**
   * Cap on the print's own width, in px. Defaults to 560 — the single-column
   * item page's treatment, unchanged: under the 720px prose measure a print
   * any wider than this stops reading as an object laid on the table and
   * starts reading as a banner.
   *
   * Pass `null` to drop the cap and let the print fill whatever box it is
   * given, which is what the two-column desktop item page does (#222): there
   * the column itself is the constraint, and a second cap inside it is one
   * more number to keep in sync for no benefit. At today's numbers the 560
   * would in fact never bind — the left column tops out around 471px, since
   * the `grid` measure is 1100 and the split gives the print five of eleven
   * parts — so this is deliberately belt-and-braces: it keeps "the column
   * decides" true by construction rather than by arithmetic that a later
   * change to the measure or the split would quietly invalidate.
   */
  maxWidth?: number | null | undefined;
};

export function PhotoCarousel({ photos, maxWidth = 560 }: PhotoCarouselProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const [width, setWidth] = React.useState(0);
  const [index, setIndex] = React.useState(0);

  function handleLayout(event: LayoutChangeEvent): void {
    setWidth(event.nativeEvent.layout.width);
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void {
    if (width === 0) return;
    setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  }

  const cover = photos[0];

  return (
    <Print tiltDeg={-1.2} style={{ padding: 12, alignSelf: "center", width: "100%", maxWidth: maxWidth ?? undefined, gap: space.sm }}>
      <View
        onLayout={handleLayout}
        style={{ width: "100%", aspectRatio: 4 / 3, overflow: "hidden", backgroundColor: colors.tableEdge }}
      >
        {width > 0 ? (
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} onScroll={handleScroll} scrollEventThrottle={16}>
            {photos.map((photo) => (
              <View key={photo.id} style={{ width, height: "100%" }}>
                <ExpoImage
                  source={photo.url_full}
                  placeholder={{ blurhash: photo.blurhash }}
                  style={{ width: "100%", height: "100%" }}
                  contentFit="cover"
                  transition={motion.imageFadeMs}
                  accessibilityLabel=""
                />
              </View>
            ))}
          </ScrollView>
        ) : cover !== undefined ? (
          <ExpoImage
            source={cover.url_full}
            placeholder={{ blurhash: cover.blurhash }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
            accessibilityLabel=""
          />
        ) : null}
      </View>

      {photos.length > 1 ? (
        <View accessibilityRole="tablist" style={{ flexDirection: "row", justifyContent: "center", gap: space.xs, paddingTop: space.xxs }}>
          {photos.map((photo, photoIndex) => (
            <View
              key={photo.id}
              accessibilityElementsHidden
              style={{
                width: 6,
                height: 6,
                backgroundColor: photoIndex === index ? colors.accent : colors.ink,
                opacity: photoIndex === index ? 1 : 0.25,
              }}
            />
          ))}
        </View>
      ) : null}
    </Print>
  );
}
