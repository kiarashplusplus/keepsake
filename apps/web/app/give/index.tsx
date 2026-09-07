// Give flow — step 1 of 5: photos. Uploads happen immediately on pick (not
// deferred to submit), so by the review step every photo is already a real
// `PublicPhoto` id the API can attach to the listing.
import * as React from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import { MAX_PHOTOS } from "@keepsake/contracts/photo";
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
import { coverPhoto, makeClientId, type GiveDraftPhoto } from "@/features/give/giveDraft";
import { tiltDegForId } from "@/lib/masonry";
import { pickImages } from "@/lib/images/pickImages";
import { prepareUpload } from "@/lib/images/prepareUpload";
import { useFileDrop } from "@/lib/images/useFileDrop";
import { ImagePrepError } from "@/lib/images/resizeImage";
import { uploadPhoto, deletePhoto } from "@/api/photos";
import { ApiError } from "@/api/client";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

/**
 * Classifies whatever `processFile` caught into the copy the giver reads, a
 * stable code for analytics, and whether a retry is worth offering.
 *
 * A refusal (wrong shape, wrong format, too big) would fail identically on a
 * second attempt, so offering "Try again" there is a small lie. A timeout, a
 * network failure (`ApiError` with status 0) or a 5xx is the case retry
 * exists for.
 */
function classifyUploadFailure(error: unknown): { message: string; errorCode: string; canRetry: boolean } {
  if (error instanceof ImagePrepError) {
    return { message: error.message, errorCode: error.code, canRetry: error.code === "timed_out" };
  }
  if (error instanceof ApiError) {
    return {
      message: error.message,
      errorCode: error.code,
      canRetry: error.status === 0 || error.status >= 500 || error.code === "rate_limited",
    };
  }
  return { message: "That upload didn't go through. Try again.", errorCode: "unknown", canRetry: true };
}

const TILE = 140;

type PhotoTileProps = {
  photo: GiveDraftPhoto;
  index: number;
  total: number;
  isCover: boolean;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onRetry: () => void;
};

function PhotoTile({ photo, index, total, isCover, onRemove, onMove, onRetry }: PhotoTileProps): React.ReactElement {
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
          {isCover ? (
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
        <View style={{ gap: space.xs }}>
          <Text variant="caption" color="dangerText">
            {photo.error ?? "Something went wrong."}
          </Text>
          {/* Only when the failure could plausibly go the other way — see
              `classifyUploadFailure`. A retry button on a refused format is
              an invitation to waste time. */}
          {photo.canRetry ? <Button label="Try again" variant="secondary" onPress={onRetry} /> : null}
        </View>
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

  // Source `File`s kept alive so "Try again" can re-run the pipeline without
  // making the giver pick the photo a second time. Dropped on remove and on
  // unmount; a draft rehydrated from `sessionStorage` has none, which is why
  // `handleRetry` degrades rather than assuming one is there.
  const sourcesRef = React.useRef(new Map<string, File>());
  // One controller per in-flight tile, so removing a tile (or leaving the
  // screen) actually stops the work rather than letting it land on a photo
  // nobody is waiting for.
  const abortsRef = React.useRef(new Map<string, AbortController>());
  // Every object URL this screen has minted. `handleRemove` revokes as it
  // goes; this is the backstop for unmount, which previously revoked nothing
  // — including on the successful-give path, where `review.tsx` resets the
  // draft and drops every URL on the floor in a long-lived tab.
  const objectUrlsRef = React.useRef(new Set<string>());
  // Guards a double-tap on "+ Add" opening two pickers that each captured the
  // same remaining-slot count. The consequence was deferred and confusing: a
  // sixth photo uploads fine and then `CreateListingInput`'s `.max(5)` fails
  // the submit four screens later.
  const pickingRef = React.useRef(false);

  // `intakeFiles` awaits between photos, so the slot count has to be read from
  // a ref rather than the closure's render-time value. Written from an effect,
  // not during render — a render-phase write isn't safe under concurrent
  // rendering. The loop always yields at an `await` before re-reading, so the
  // commit and this effect have both run by then.
  const photosRef = React.useRef(draft.photos);
  React.useEffect(() => {
    photosRef.current = draft.photos;
  }, [draft.photos]);

  const remainingSlots = MAX_PHOTOS - draft.photos.length;

  const trackObjectUrl = React.useCallback((url: string): string => {
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  const releaseObjectUrl = React.useCallback((url: string | null): void => {
    if (url === null) return;
    objectUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  React.useEffect(() => {
    const aborts = abortsRef.current;
    const objectUrls = objectUrlsRef.current;
    const sources = sourcesRef.current;
    return () => {
      for (const controller of aborts.values()) controller.abort();
      aborts.clear();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      sources.clear();
    };
  }, []);

  /**
   * Runs the pipeline and the upload for one already-registered tile. The tile
   * must already exist in the draft (either freshly added by `processFile` or
   * reset by `handleRetry`) — this only ever patches.
   *
   * `supersedes` is the object URL currently on the tile, which this replaces
   * on success. Revoking it here, rather than in the caller after the await,
   * is deliberate: `photosRef` is updated from an effect, so a caller checking
   * it straight after `await runUpload(...)` may read a state React has not
   * committed yet and skip the revoke.
   */
  async function runUpload(file: File, clientId: string, supersedes: string | null): Promise<void> {
    const controller = new AbortController();
    abortsRef.current.get(clientId)?.abort();
    abortsRef.current.set(clientId, controller);

    try {
      const prepared = await prepareUpload(file, { signal: controller.signal });
      const uploaded = await uploadPhoto({
        full: prepared.full.blob,
        thumb: prepared.thumb.blob,
        width: prepared.full.width,
        height: prepared.full.height,
        blurhash: prepared.blurhash,
        signal: controller.signal,
      });

      const thumbUrl = trackObjectUrl(URL.createObjectURL(prepared.thumb.blob));
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
          errorCode: null,
          canRetry: false,
        },
      });
      releaseObjectUrl(supersedes);
      track(AnalyticsEvents.GivePhotoUploaded);
    } catch (error) {
      // An abort means the tile (or the whole screen) is gone. Dispatching
      // would either be a no-op or resurrect a tile the giver just removed.
      if (error instanceof DOMException && error.name === "AbortError") return;

      const { message, errorCode, canRetry } = classifyUploadFailure(error);
      dispatch({ type: "update_photo", clientId, patch: { status: "error", error: message, errorCode, canRetry } });
      track(AnalyticsEvents.GivePhotoFailed, { code: errorCode });
    } finally {
      if (abortsRef.current.get(clientId) === controller) abortsRef.current.delete(clientId);
    }
  }

  async function processFile(file: File): Promise<void> {
    const clientId = makeClientId();
    sourcesRef.current.set(clientId, file);

    // The preview is the source file itself, shown immediately so the tile
    // isn't blank while the pipeline runs. It's replaced by the encoded thumb
    // on success and kept as-is on failure, so the giver can see which photo
    // the error is about.
    const previewUrl = trackObjectUrl(URL.createObjectURL(file));
    dispatch({
      type: "add_photo",
      photo: {
        clientId,
        id: null,
        objectUrl: previewUrl,
        // Real dimensions aren't known until the decode, which is now inside
        // `prepareUpload`. Nothing reads these while `status` is "uploading".
        width: 0,
        height: 0,
        blurhash: "",
        status: "uploading",
        error: null,
        errorCode: null,
        canRetry: false,
      },
    });

    // On success `runUpload` swaps in the encoded thumb and revokes this
    // preview; on failure it keeps it, so the giver can see which photo the
    // error is about.
    await runUpload(file, clientId, previewUrl);
  }

  function handleRetry(photo: GiveDraftPhoto): void {
    const file = sourcesRef.current.get(photo.clientId);
    if (file === undefined) return;
    dispatch({
      type: "update_photo",
      clientId: photo.clientId,
      patch: { status: "uploading", error: null, errorCode: null, canRetry: false },
    });
    void runUpload(file, photo.clientId, photo.objectUrl);
  }

  /** The one intake every source funnels through — the picker, a drop, and a
   * paste all land here so the slot bound and the sequencing are enforced
   * once rather than three times. */
  async function intakeFiles(files: File[]): Promise<void> {
    for (const file of files) {
      // Recomputed each iteration rather than sliced up front: `processFile`
      // awaits, and the draft it's adding to is the same one this bound is
      // derived from.
      if (MAX_PHOTOS - photosRef.current.length <= 0) break;
      // Sequential on purpose: several photos' pipelines at once is a good
      // way to peg a phone's CPU and OOM the tab. (Each photo is now a single
      // decode — see `prepareUpload` — but five of those in parallel is still
      // five full-size bitmaps resident at once.)
      await processFile(file);
    }
  }

  async function handleAddPhoto(): Promise<void> {
    if (pickingRef.current) return;
    if (MAX_PHOTOS - photosRef.current.length <= 0) return;
    pickingRef.current = true;
    try {
      await intakeFiles(await pickImages({ multiple: true }));
    } finally {
      pickingRef.current = false;
    }
  }

  const { isDraggingOver } = useFileDrop({
    enabled: remainingSlots > 0,
    onFiles: (files) => {
      void intakeFiles(files);
    },
  });

  function handleRemove(photo: GiveDraftPhoto): void {
    // Stop the work before dropping the tile: an in-flight pipeline whose
    // upload has not yet reached the server leaves no row at all, and one
    // that has is handled by the `deletePhoto` below.
    abortsRef.current.get(photo.clientId)?.abort();
    abortsRef.current.delete(photo.clientId);
    sourcesRef.current.delete(photo.clientId);
    releaseObjectUrl(photo.objectUrl);
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
  const cover = coverPhoto(draft);

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
            One to five photos. The first one is what people see first. You can drop them here or paste one.
          </Text>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {draft.photos.map((photo, index) => (
            <PhotoTile
              key={photo.clientId}
              photo={photo}
              index={index}
              total={draft.photos.length}
              isCover={cover !== null && cover.clientId === photo.clientId}
              onRemove={() => handleRemove(photo)}
              onMove={(direction) => dispatch({ type: "move_photo", clientId: photo.clientId, direction })}
              onRetry={() => handleRetry(photo)}
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
                ...(isDraggingOver ? { backgroundColor: colors.tableEdge } : {}),
              }}
            >
              <Text variant="label" color="ink" style={{ fontSize: 12 }}>
                {isDraggingOver ? "Drop here" : "+ Add"}
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
