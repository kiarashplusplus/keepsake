// Full-size photo carousel for the item page: horizontal paging ScrollView
// with dots, `expo-image` at `url_full` with a blurhash placeholder so the
// first paint is never a blank box.
import * as React from "react";
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Image as ExpoImage } from "expo-image";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";

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
    <View style={{ gap: space.sm }}>
      <View
        onLayout={handleLayout}
        style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: radii.lg, overflow: "hidden", backgroundColor: colors.surfaceSunken }}
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
        <View accessibilityRole="tablist" style={{ flexDirection: "row", justifyContent: "center", gap: space.xs }}>
          {photos.map((photo, photoIndex) => (
            <View
              key={photo.id}
              accessibilityElementsHidden
              style={{
                width: 6,
                height: 6,
                borderRadius: radii.pill,
                backgroundColor: photoIndex === index ? colors.accent : colors.rule,
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
