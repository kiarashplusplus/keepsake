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

export function PhotoCarousel({ photos }: { photos: readonly PublicPhoto[] }): React.ReactElement {
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
    <Print tiltDeg={-1.2} style={{ padding: 12, alignSelf: "center", width: "100%", maxWidth: 560, gap: space.sm }}>
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
