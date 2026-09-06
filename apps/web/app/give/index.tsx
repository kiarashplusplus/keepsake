// Give flow — step 1 of 5: photos. Uploads happen immediately on pick (not
// deferred to submit), so by the review step every photo is already a real
// `PublicPhoto` id the API can attach to the listing.
import * as React from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import { FULL_EDGE_PX, MAX_PHOTOS, THUMB_EDGE_PX } from "@keepsake/contracts/photo";
import { space } from "@keepsake/tokens/spacing";
import { motion } from "@keepsake/tokens/motion";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Print } from "@/ui/Print";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { useColors } from "@/ui/theme";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { makeClientId, type GiveDraftPhoto } from "@/features/give/giveDraft";
import { tiltDegForId } from "@/lib/masonry";
import { pickImages } from "@/lib/images/pickImages";
import { readImageDimensions, resizeImage } from "@/lib/images/resizeImage";
import { IMAGE_VALIDATION_MESSAGES, validateImageDimensions, validateImageFile } from "@/lib/images/validateImage";
import { encodeBlurhashFromBlob } from "@/lib/images/blurhash";
import { uploadPhoto, deletePhoto } from "@/api/photos";
import { ApiError } from "@/api/client";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

function errorPhoto(clientId: string, message: string): GiveDraftPhoto {
  return { clientId, id: null, objectUrl: null, width: 0, height: 0, blurhash: "", status: "error", error: message };
}

const TILE = 140;

type PhotoTileProps = {
  photo: GiveDraftPhoto;
  index: number;
  total: number;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
};

function PhotoTile({ photo, index, total, onRemove, onMove }: PhotoTileProps): React.ReactElement {
  const colors = useColors();
  const overlayStyle: ViewStyle = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.overlay,
  };

  return (
    <View style={{ width: TILE, gap: space.xs }}>
      <Print tiltDeg={tiltDegForId(photo.clientId, motion.tiltRangeDeg)} style={{ width: TILE, height: TILE, padding: 6 }}>
        <View
          style={{
            width: "100%",
            height: "100%",
            overflow: "hidden",
            backgroundColor: colors.tableEdge,
          }}
        >
          <ExpoImage
            source={photo.objectUrl !== null ? { uri: photo.objectUrl } : null}
            placeholder={photo.blurhash !== "" ? { blurhash: photo.blurhash } : null}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
            accessibilityLabel={`Keepsake photo ${index + 1}`}
          />
          {photo.status === "uploading" ? (
            <View style={overlayStyle}>
              <Text variant="caption" style={{ color: colors.print }}>
                uploading…
              </Text>
            </View>
          ) : null}
          {index === 0 && photo.status === "done" ? (
            <View
              style={{
                position: "absolute",
                bottom: space.xs,
                left: space.xs,
                backgroundColor: colors.print,
                paddingHorizontal: space.xs,
                paddingVertical: 1,
              }}
            >
              <Text variant="label" color="ink" style={{ fontSize: 9 }}>
                Cover
              </Text>
            </View>
          ) : null}
        </View>
      </Print>

      {photo.status === "error" ? (
        <Text variant="caption" color="dangerText">
          {photo.error ?? "Something went wrong."}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row" }}>
          <IconButton icon="chevron-back" label="Move earlier" size={16} disabled={index === 0} onPress={() => onMove(-1)} />
          <IconButton icon="chevron-forward" label="Move later" size={16} disabled={index === total - 1} onPress={() => onMove(1)} />
        </View>
        <IconButton icon="trash-outline" label="Remove photo" size={16} onPress={onRemove} />
      </View>
    </View>
  );
}

export default function GivePhotos(): React.ReactElement {
  const router = useRouter();
  const colors = useColors();
  const { draft, dispatch } = useGiveDraft();

  React.useEffect(() => {
    track(AnalyticsEvents.GiveStarted);
  }, []);

  const remainingSlots = MAX_PHOTOS - draft.photos.length;

  async function processFile(file: File): Promise<void> {
    const clientId = makeClientId();

    const typeOrSizeError = validateImageFile(file);
    if (typeOrSizeError !== null) {
      dispatch({ type: "add_photo", photo: errorPhoto(clientId, IMAGE_VALIDATION_MESSAGES[typeOrSizeError]) });
      return;
    }

    let sourceDims: { width: number; height: number };
    try {
      sourceDims = await readImageDimensions(file);
    } catch {
      dispatch({ type: "add_photo", photo: errorPhoto(clientId, "Couldn't read that photo. Try another.") });
      return;
    }

    const dimError = validateImageDimensions(sourceDims.width, sourceDims.height);
    if (dimError !== null) {
      dispatch({ type: "add_photo", photo: errorPhoto(clientId, IMAGE_VALIDATION_MESSAGES[dimError]) });
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    dispatch({
      type: "add_photo",
      photo: {
        clientId,
        id: null,
        objectUrl: previewUrl,
        width: sourceDims.width,
        height: sourceDims.height,
        blurhash: "",
        status: "uploading",
        error: null,
      },
    });

    try {
      const [full, thumb] = await Promise.all([resizeImage(file, FULL_EDGE_PX), resizeImage(file, THUMB_EDGE_PX)]);
      const blurhash = await encodeBlurhashFromBlob(thumb.blob);
      const uploaded = await uploadPhoto({ full: full.blob, thumb: thumb.blob, width: full.width, height: full.height, blurhash });

      URL.revokeObjectURL(previewUrl);
      const thumbUrl = URL.createObjectURL(thumb.blob);

      dispatch({
        type: "update_photo",
        clientId,
        patch: {
          id: uploaded.id,
          objectUrl: thumbUrl,
          width: uploaded.width,
          height: uploaded.height,
          blurhash: uploaded.blurhash,
          status: "done",
          error: null,
        },
      });
      track(AnalyticsEvents.GivePhotoUploaded);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "That upload didn't go through. Try again.";
      dispatch({ type: "update_photo", clientId, patch: { status: "error", error: message } });
    }
  }

  async function handleAddPhoto(): Promise<void> {
    if (remainingSlots <= 0) return;
    const files = await pickImages({ multiple: true });
    for (const file of files.slice(0, remainingSlots)) {
      // Sequential on purpose: parallel resizes of several full-size photos
      // at once is a good way to peg a phone's CPU and OOM the tab.
      await processFile(file);
    }
  }

  function handleRemove(photo: GiveDraftPhoto): void {
    if (photo.objectUrl !== null) URL.revokeObjectURL(photo.objectUrl);
    if (photo.id !== null) {
      deletePhoto(photo.id).catch(() => {
        // Best-effort cleanup — an orphaned photo row is swept server-side.
      });
    }
    dispatch({ type: "remove_photo", clientId: photo.clientId });
  }

  const doneCount = draft.photos.filter((photo) => photo.status === "done").length;
  const isUploading = draft.photos.some((photo) => photo.status === "uploading");
  const canContinue = doneCount >= 1 && !isUploading;

  return (
    // `Page`, not a bare `Card`: this step is rendered by the give flow's
    // nested `<Stack>` (`app/give/_layout.tsx`), whose screens are
    // `position: absolute` and so size against a distant definite-height
    // ancestor rather than the in-flow `StepShell` around them — a `Page`
    // has to live *here*, per step, not once in the shell. No `variant`:
    // `StepShell` already wraps every step in one `ReadableWidth`, so a
    // second one here would double the horizontal gutter.
    <Page>
      <Card style={{ gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow>Photos</Eyebrow>
          <Text variant="displayLg">Show us the keepsake.</Text>
          <Text variant="bodyLg" color="textSecondary">
            One to five photos. The first one is what people see first.
          </Text>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {draft.photos.map((photo, index) => (
            <PhotoTile
              key={photo.clientId}
              photo={photo}
              index={index}
              total={draft.photos.length}
              onRemove={() => handleRemove(photo)}
              onMove={(direction) => dispatch({ type: "move_photo", clientId: photo.clientId, direction })}
            />
          ))}

          {remainingSlots > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add photos"
              onPress={() => void handleAddPhoto()}
              style={{
                width: TILE,
                height: TILE,
                borderWidth: 2,
                borderColor: colors.ink,
                borderStyle: "dashed",
                alignItems: "center",
                justifyContent: "center",
                gap: space.xs,
              }}
            >
              <Text variant="label" color="ink" style={{ fontSize: 12 }}>
                + Add
              </Text>
              <Text variant="caption" color="textTertiary">
                {remainingSlots} left
              </Text>
            </Pressable>
          ) : null}
        </View>

        <View style={{ flexDirection: "row" }}>
          <Button label="Continue" disabled={!canContinue} onPress={() => router.push("/give/story")} />
        </View>
      </Card>
    </Page>
  );
}
