// Batch workspace — Photos: add photos to the tray, then an explicit
// choice ("Group as one item" or "One item per photo") turns a selection
// into items. Every grouped item gets its own row below the tray, with
// per-photo cover/remove buttons and a "Split" to dissolve it back to the
// tray — no action here depends on a drag interaction.
import * as React from "react";
import { Pressable, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { MAX_PHOTOS } from "@keepsake/contracts/photo";
import { MAX_BATCH_ITEMS, MAX_BATCH_PHOTOS } from "@keepsake/contracts/bulk";
import { space } from "@keepsake/tokens/spacing";
import { motion } from "@keepsake/tokens/motion";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Print } from "@/ui/Print";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { Input } from "@/ui/Input";
import { TableHeading } from "@/ui/TableHeading";
import { useColors } from "@/ui/theme";
import { useBulkWorkspaceContext } from "@/features/bulk/BulkWorkspaceContext";
import { listItems, unassignedPhotos, type BulkDraftItem, type BulkDraftPhoto } from "@/features/bulk/batchStore";
import { useBulkPhotoSource } from "@/features/bulk/photoSource";
import { tiltDegForId } from "@/lib/masonry";
import { pickImages } from "@/lib/images/pickImages";
import { useFileDrop } from "@/lib/images/useFileDrop";

const TILE = 120;

function fileKey(file: File): string {
  return `${file.name}:${file.size}`;
}

function TrayTile({
  photo,
  selected,
  onToggle,
  onRemove,
  onRetry,
}: {
  photo: BulkDraftPhoto;
  selected: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onRetry: () => void;
}): React.ReactElement {
  const colors = useColors();
  const source = useBulkPhotoSource(photo);

  return (
    <View style={{ width: TILE, gap: space.xs }}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel="Select this photo" onPress={onToggle}>
        <Print tiltDeg={tiltDegForId(photo.clientPhotoId, motion.tiltRangeDeg)} style={{ width: TILE, height: TILE, padding: 6 }}>
          <View style={{ width: "100%", height: "100%", overflow: "hidden", backgroundColor: colors.tableEdge }}>
            <ExpoImage
              source={source}
              placeholder={photo.blurhash !== null && photo.blurhash !== "" ? { blurhash: photo.blurhash } : null}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              accessibilityLabel="Batch photo"
            />
            {photo.status === "uploading" || photo.status === "queued" ? (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.overlay,
                }}
              >
                <Text variant="caption" style={{ color: colors.print }}>
                  {photo.status === "uploading" ? "uploading…" : "queued…"}
                </Text>
              </View>
            ) : null}
            <View
              style={{
                position: "absolute",
                top: space.xs,
                left: space.xs,
                width: 22,
                height: 22,
                borderRadius: 11,
                borderWidth: 2,
                borderColor: colors.ink,
                backgroundColor: selected ? colors.accent : colors.print,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {selected ? (
                <Text variant="label" style={{ color: colors.onAccent, fontSize: 10 }}>
                  ✓
                </Text>
              ) : null}
            </View>
          </View>
        </Print>
      </Pressable>

      {photo.status === "retryable_failure" || photo.status === "permanent_failure" ? (
        <View style={{ gap: space.xxs }}>
          <Text variant="caption" color="dangerText">
            {photo.error ?? "Something went wrong."}
          </Text>
          {photo.canRetry ? <Button label="Try again" variant="secondary" onPress={onRetry} /> : null}
        </View>
      ) : null}
      {photo.needsReselection ? (
        <Text variant="caption" color="dangerText">
          Needs re-selecting.
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <IconButton icon="trash-outline" label="Remove photo" size={16} onPress={onRemove} />
      </View>
    </View>
  );
}

function GroupThumb({
  photo,
  isCover,
  onMakeCover,
  onRemove,
}: {
  photo: BulkDraftPhoto | undefined;
  isCover: boolean;
  onMakeCover: () => void;
  onRemove: () => void;
}): React.ReactElement {
  const colors = useColors();
  const source = useBulkPhotoSource(photo ?? null);
  if (photo === undefined) return <View />;

  return (
    <View style={{ width: 72, gap: space.xxs }}>
      <View style={{ width: 72, height: 72, overflow: "hidden", borderRadius: 2, backgroundColor: colors.tableEdge, borderWidth: isCover ? 2 : 0, borderColor: colors.accent }}>
        <ExpoImage
          source={source}
          placeholder={photo.blurhash !== null && photo.blurhash !== "" ? { blurhash: photo.blurhash } : null}
          style={{ width: "100%", height: "100%" }}
          contentFit="cover"
          accessibilityLabel="Item photo"
        />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {isCover ? (
          <Text variant="caption" color="textTertiary" style={{ fontSize: 9 }}>
            Cover
          </Text>
        ) : (
          <IconButton icon="star-outline" label="Make this the cover" size={12} onPress={onMakeCover} style={{ width: 28, height: 28 }} />
        )}
        <IconButton icon="close" label="Remove from this item" size={12} onPress={onRemove} style={{ width: 28, height: 28 }} />
      </View>
    </View>
  );
}

function ItemGroupRow({
  item,
  selectedTrayIds,
  onCleared,
}: {
  item: BulkDraftItem;
  selectedTrayIds: string[];
  onCleared: () => void;
}): React.ReactElement {
  const workspace = useBulkWorkspaceContext();
  const [busy, setBusy] = React.useState(false);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [roomLabel, setRoomLabel] = React.useState(item.roomLabel ?? "");
  const [lotLabel, setLotLabel] = React.useState(item.lotLabel ?? "");

  async function run(action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setBusy(true);
    setRowError(null);
    const result = await action();
    if (!result.ok) setRowError(result.error ?? "That didn't go through.");
    setBusy(false);
  }

  return (
    <Card style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text variant="title" numberOfLines={1}>
          {item.fields.title !== undefined && item.fields.title !== "" ? item.fields.title : `${item.photoClientIds.length} photo${item.photoClientIds.length === 1 ? "" : "s"}`}
        </Text>
        <Button
          label="Split"
          variant="ghost"
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void workspace.dissolveItem(item.clientItemId).finally(() => setBusy(false));
          }}
        />
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {item.photoClientIds.map((clientPhotoId, index) => (
          <GroupThumb
            key={clientPhotoId}
            photo={workspace.state.photos[clientPhotoId]}
            isCover={index === 0}
            onMakeCover={() => void run(() => workspace.setCoverPhoto(item.clientItemId, clientPhotoId))}
            onRemove={() => void run(() => workspace.removePhotoFromItem(item.clientItemId, clientPhotoId))}
          />
        ))}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <Input label="Room (private)" value={roomLabel} onChangeText={setRoomLabel} onBlur={() => workspace.setItemLabels(item.clientItemId, { roomLabel: roomLabel.trim() === "" ? null : roomLabel.trim() })} placeholder="Attic" style={{ flexGrow: 1, minWidth: 140 }} />
        <Input label="Lot (private)" value={lotLabel} onChangeText={setLotLabel} onBlur={() => workspace.setItemLabels(item.clientItemId, { lotLabel: lotLabel.trim() === "" ? null : lotLabel.trim() })} placeholder="Box 3" style={{ flexGrow: 1, minWidth: 140 }} />
      </View>

      {selectedTrayIds.length > 0 ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            label={`Add ${selectedTrayIds.length} selected photo${selectedTrayIds.length === 1 ? "" : "s"} here`}
            variant="secondary"
            disabled={busy || item.photoClientIds.length >= MAX_PHOTOS}
            onPress={() =>
              void run(async () => {
                const result = await workspace.addPhotosToItem(item.clientItemId, selectedTrayIds);
                if (result.ok) onCleared();
                return result;
              })
            }
          />
        </View>
      ) : null}

      {rowError !== null ? (
        <Text variant="caption" color="dangerText">
          {rowError}
        </Text>
      ) : null}
    </Card>
  );
}

export default function BulkPhotos(): React.ReactElement {
  const colors = useColors();
  const workspace = useBulkWorkspaceContext();
  const { state } = workspace;

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [pickError, setPickError] = React.useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = React.useState<string | null>(null);
  const pickingRef = React.useRef(false);
  const seenFilesRef = React.useRef<Set<string>>(new Set());

  const tray = unassignedPhotos(state);
  const items = listItems(state);
  const totalPhotos = Object.keys(state.photos).length;
  const remainingSlots = MAX_BATCH_PHOTOS - totalPhotos;

  async function intake(files: File[]): Promise<void> {
    const duplicates = files.filter((f) => seenFilesRef.current.has(fileKey(f)));
    if (duplicates.length > 0) {
      setDuplicateWarning(
        `${duplicates.length} of these look like a file you already added (${duplicates.map((f) => f.name).join(", ")}). Added anyway — remove any you didn't mean to duplicate.`,
      );
    } else {
      setDuplicateWarning(null);
    }
    const toAdd = files.slice(0, Math.max(0, remainingSlots));
    if (toAdd.length < files.length) {
      setPickError(`This batch can hold ${MAX_BATCH_PHOTOS} photos — only ${toAdd.length} of ${files.length} were added.`);
    } else {
      setPickError(null);
    }
    // Only files actually added count as "seen" — a file dropped by the
    // cap slice above was never added to the batch, so marking it seen
    // would produce a false duplicate warning if the giver frees a slot and
    // re-picks it later (#294).
    for (const f of toAdd) seenFilesRef.current.add(fileKey(f));
    await workspace.addPhotos(toAdd);
  }

  async function handleAddPress(): Promise<void> {
    if (pickingRef.current || remainingSlots <= 0) return;
    pickingRef.current = true;
    try {
      await intake(await pickImages({ multiple: true }));
    } finally {
      pickingRef.current = false;
    }
  }

  const { isDraggingOver } = useFileDrop({ enabled: remainingSlots > 0, onFiles: (files) => void intake(files) });

  function toggleSelected(clientPhotoId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clientPhotoId)) next.delete(clientPhotoId);
      else next.add(clientPhotoId);
      return next;
    });
  }

  const selectedIds = Array.from(selected);
  const canGroupAsOne = selectedIds.length >= 1 && selectedIds.length <= MAX_PHOTOS && items.length < MAX_BATCH_ITEMS;
  const canGroupOnePerPhoto = selectedIds.length >= 1 && items.length + selectedIds.length <= MAX_BATCH_ITEMS;
  const [groupError, setGroupError] = React.useState<string | null>(null);

  async function handleGroupAsOne(): Promise<void> {
    const result = await workspace.groupAsOneItem(selectedIds);
    if (!result.ok) {
      setGroupError(result.error ?? "That didn't go through.");
      return;
    }
    setGroupError(null);
    setSelected(new Set());
  }

  async function handleGroupOnePerPhoto(): Promise<void> {
    const result = await workspace.groupOnePerPhoto(selectedIds);
    if (!result.ok) {
      setGroupError(result.error ?? "That didn't go through.");
      return;
    }
    setGroupError(null);
    setSelected(new Set());
  }

  return (
    <Page>
      <View style={{ gap: space.xl }}>
        <Card style={{ gap: space.lg }}>
          <View style={{ gap: space.xs }}>
            <Eyebrow>Photos</Eyebrow>
            <Text variant="displayLg">Add and group photos.</Text>
            <Text variant="bodyLg" color="textSecondary">
              Add everything first, then select photos and choose how they group into items. {totalPhotos} of {MAX_BATCH_PHOTOS} photos.
            </Text>
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            {tray.map((photo) => (
              <TrayTile
                key={photo.clientPhotoId}
                photo={photo}
                selected={selected.has(photo.clientPhotoId)}
                onToggle={() => toggleSelected(photo.clientPhotoId)}
                onRemove={() => void workspace.removePhoto(photo.clientPhotoId)}
                onRetry={() => {
                  // The queue keeps a retryable photo's source resident in
                  // IndexedDB when it can (`needsReselection: false`)
                  // specifically so a retry doesn't need a re-pick — only
                  // fall back to the file picker when the source is
                  // genuinely gone (#293).
                  if (!photo.needsReselection) {
                    workspace.retryPhoto(photo.clientPhotoId);
                    return;
                  }
                  void pickImages({ multiple: false }).then((files) => {
                    const file = files[0];
                    if (file !== undefined) workspace.retryPhoto(photo.clientPhotoId, file);
                  });
                }}
              />
            ))}

            {remainingSlots > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add photos"
                onPress={() => void handleAddPress()}
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

          {pickError !== null ? (
            <Text variant="caption" color="dangerText">
              {pickError}
            </Text>
          ) : null}
          {duplicateWarning !== null ? (
            <Text variant="caption" color="foilText">
              {duplicateWarning}
            </Text>
          ) : null}

          {selectedIds.length > 0 ? (
            <View style={{ gap: space.sm, paddingTop: space.sm }}>
              <Text variant="body" color="ink">
                {selectedIds.length} photo{selectedIds.length === 1 ? "" : "s"} selected.
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "center" }}>
                <Button label={`Group as one item (${selectedIds.length} photos)`} disabled={!canGroupAsOne} onPress={() => void handleGroupAsOne()} />
                <Button
                  label={`One item per photo (${selectedIds.length} item${selectedIds.length === 1 ? "" : "s"})`}
                  variant="secondary"
                  disabled={!canGroupOnePerPhoto}
                  onPress={() => void handleGroupOnePerPhoto()}
                />
                <Button label="Clear selection" variant="ghost" onPress={() => setSelected(new Set())} />
              </View>
              {groupError !== null ? (
                <Text variant="caption" color="dangerText">
                  {groupError}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Card>

        {items.length > 0 ? (
          <View style={{ gap: space.md }}>
            <TableHeading note={`${items.length} of ${MAX_BATCH_ITEMS}`}>Grouped so far</TableHeading>
            <View style={{ gap: space.md }}>
              {items.map((item) => (
                <ItemGroupRow key={item.clientItemId} item={item} selectedTrayIds={selectedIds} onCleared={() => setSelected(new Set())} />
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </Page>
  );
}
