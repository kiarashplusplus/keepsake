// Batch workspace — Review: one card per item (cover, story, title,
// category, suggested condition, private labels, status), select several
// and "apply to selected" a room/lot label or the batch's shared story.
// Compact list on desktop; one expanded card at a time on a phone.
import * as React from "react";
import { useWindowDimensions, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { CATEGORIES, CATEGORY_LABELS, STORY_MAX, TITLE_MAX } from "@keepsake/contracts/listing";
import type { Category } from "@keepsake/contracts/listing";
import { normalizeCondition } from "@keepsake/contracts/photo";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Chip } from "@/ui/Chip";
import { Input } from "@/ui/Input";
import { TextArea } from "@/ui/TextArea";
import { Print } from "@/ui/Print";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { Sheet } from "@/ui/Sheet";
import { TableHeading } from "@/ui/TableHeading";
import { useColors } from "@/ui/theme";
import { useBulkWorkspaceContext } from "@/features/bulk/BulkWorkspaceContext";
import { listItems, listPhotosForItem, type BulkDraftItem } from "@/features/bulk/batchStore";
import { useBulkPhotoSource } from "@/features/bulk/photoSource";
import type { SuggestionPreview } from "@/features/bulk/useBulkWorkspace";

const NARROW_BREAKPOINT = 640;

const STATE_LABEL: Record<BulkDraftItem["state"], string> = {
  editing: "Editing",
  ready: "Ready",
  queued: "Submitting",
  submitted: "Submitted",
  failed: "Needs attention",
};

/**
 * `item.state` is the raw `upload_batch_items.state` column, and nothing
 * ever writes it to `"ready"` — the API's own doc comment on
 * `BATCH_ITEM_STATES` (and PR #263's "What was NOT faked") says so plainly:
 * readiness is computed live by `checkItemReadiness`
 * (`apps/api/src/bulk/batches.ts`) and returned as the separate `ready`
 * boolean, never persisted back onto `state`. Reading `STATE_LABEL` off
 * `item.state` alone therefore showed "Editing" for a fully ready item
 * forever, in whatever color this same badge picked for readiness below —
 * a green (or amber) "Editing" is not a state a giver could make sense of.
 * This is the one place that gap has to be bridged for a human to see it.
 */
function stateLabelFor(item: BulkDraftItem): string {
  if (item.state === "editing" && item.ready === true) return "Ready";
  return STATE_LABEL[item.state];
}

function ItemCard({ item, selected, onToggleSelected }: { item: BulkDraftItem; selected: boolean; onToggleSelected: () => void }): React.ReactElement {
  const colors = useColors();
  const workspace = useBulkWorkspaceContext();
  const photos = listPhotosForItem(workspace.state, item.clientItemId);
  const cover = photos[0];
  const coverSource = useBulkPhotoSource(cover ?? null);
  const [conditionDismissed, setConditionDismissed] = React.useState(false);

  const suggestion = cover !== undefined ? workspace.suggestionForPhoto(cover.clientPhotoId) : null;
  const stale = workspace.isSuggestionStale(item.clientItemId);
  // Same rule as the give flow's story step: a model that answers "No
  // visible damage" has observed nothing, and a note that says so is worse
  // than no note. `normalizeCondition` is the one place that decides.
  const condition = normalizeCondition(suggestion?.condition ?? "");
  const showCondition = !conditionDismissed && !stale && condition !== "";
  const loading = workspace.suggestionLoading[item.clientItemId] === true;

  const title = item.fields.title ?? "";
  const story = item.fields.story ?? "";
  const category = item.fields.category ?? null;

  return (
    <Card style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", gap: space.md }}>
        <Print style={{ width: 96, height: 96, padding: 4 }}>
          <View style={{ width: "100%", height: "100%", overflow: "hidden", backgroundColor: colors.tableEdge }}>
            <ExpoImage
              source={coverSource}
              placeholder={cover?.blurhash !== null && cover?.blurhash !== undefined && cover.blurhash !== "" ? { blurhash: cover.blurhash } : null}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              accessibilityLabel="Item cover photo"
            />
          </View>
        </Print>
        <View style={{ flex: 1, gap: space.xxs }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text variant="caption" color="textTertiary">
              {photos.length} photo{photos.length === 1 ? "" : "s"}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text variant="label" color={item.state === "failed" ? "dangerText" : item.ready === true ? "accent2Text" : "foilText"} style={{ fontSize: 10 }}>
                {stateLabelFor(item)}
              </Text>
              <Chip label={selected ? "Selected" : "Select"} selected={selected} onPress={onToggleSelected} />
            </View>
          </View>
          {item.blockedReason !== null && item.state !== "ready" ? (
            <Text variant="caption" color="dangerText">
              {item.blockedReason}
            </Text>
          ) : null}
        </View>
      </View>

      <Input
        label="Title"
        value={title}
        maxLength={TITLE_MAX}
        onChangeText={(text) => workspace.setItemTitle(item.clientItemId, text)}
        placeholder="A hand-thrown mug"
      />

      {showCondition ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs, paddingStart: space.md, borderStartWidth: 2, borderStartColor: colors.accent }}>
          {/* Colon rather than "The photo shows …", for the reason
              app/give/story.tsx spells out: the clause carries the model's
              own casing and only reads correctly when it starts a phrase of
              its own. */}
          <Text variant="body" color="inkSoft" style={{ flex: 1 }}>
            From this photo: {condition}. Worth a line in the story?
          </Text>
          <Button label="Dismiss" variant="ghost" onPress={() => setConditionDismissed(true)} />
        </View>
      ) : null}

      <TextArea
        label="Story"
        value={story}
        onChangeText={(text) => workspace.setItemStory(item.clientItemId, text)}
        maxLength={STORY_MAX}
        minHeight={100}
        placeholder="A gift from a trip we took together."
      />

      <View style={{ gap: space.sm }}>
        <Text variant="eyebrow" color="accent2Text">
          Category
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {CATEGORIES.map((c) => (
            <Chip key={c} label={CATEGORY_LABELS[c]} selected={category === c} onPress={() => workspace.setItemCategory(item.clientItemId, c as Category)} />
          ))}
        </View>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "center" }}>
        <Button label={loading ? "Asking…" : "Suggest from photo"} variant="secondary" loading={loading} disabled={cover === undefined || cover.photoId === null} onPress={() => void workspace.requestSuggestion(item.clientItemId)} />
        <Button label="Save now" variant="link" onPress={() => void workspace.saveItem(item.clientItemId)} />
        <Button label="Remove item" variant="ghost" onPress={() => void workspace.dissolveItem(item.clientItemId)} />
      </View>
    </Card>
  );
}

function ApplyToSelectedSheet({
  visible,
  onClose,
  selectedIds,
}: {
  visible: boolean;
  onClose: () => void;
  selectedIds: string[];
}): React.ReactElement {
  const workspace = useBulkWorkspaceContext();
  const [roomLabel, setRoomLabel] = React.useState("");
  const [lotLabel, setLotLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // Computed straight from the workspace on every render rather than
  // copied into state via an effect — `workspace`'s own identity changes
  // whenever an item's story changes (a new object each render of
  // `useBulkWorkspace`), so this sheet's preview is always current for
  // whatever is selected while it's open, with no state of its own to fall
  // out of sync.
  const preview: SuggestionPreview[] = visible ? workspace.previewSharedStoryApplication(selectedIds) : [];
  const applyCount = preview.filter((p) => !p.skipped).length;

  return (
    <Sheet visible={visible} onClose={onClose} title={`Apply to ${selectedIds.length} selected item${selectedIds.length === 1 ? "" : "s"}`}>
      <View style={{ gap: space.lg }}>
        <View style={{ gap: space.sm }}>
          <Text variant="eyebrow" color="accent2Text">
            Room (private)
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-end" }}>
            <Input label="Room" value={roomLabel} onChangeText={setRoomLabel} placeholder="Attic" style={{ flexGrow: 1 }} />
            <Button
              label="Apply"
              variant="secondary"
              disabled={busy || roomLabel.trim() === ""}
              onPress={() => {
                setBusy(true);
                void workspace.applyRoomLabelToSelected(selectedIds, roomLabel.trim()).finally(() => setBusy(false));
              }}
            />
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="eyebrow" color="accent2Text">
            Lot (private)
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-end" }}>
            <Input label="Lot" value={lotLabel} onChangeText={setLotLabel} placeholder="Box 3" style={{ flexGrow: 1 }} />
            <Button
              label="Apply"
              variant="secondary"
              disabled={busy || lotLabel.trim() === ""}
              onPress={() => {
                setBusy(true);
                void workspace.applyLotLabelToSelected(selectedIds, lotLabel.trim()).finally(() => setBusy(false));
              }}
            />
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="eyebrow" color="accent2Text">
            Shared story context
          </Text>
          {preview.length === 0 ? (
            <Text variant="caption" color="textTertiary">
              Nothing selected.
            </Text>
          ) : (
            <View style={{ gap: space.sm }}>
              {preview.map((row) => (
                <View key={row.itemClientId} style={{ gap: space.xxs }}>
                  <Text variant="label" color="ink" style={{ fontSize: 11 }}>
                    {row.title}
                  </Text>
                  {row.skipped ? (
                    <Text variant="caption" color="textTertiary">
                      Skipped — {row.reason}
                    </Text>
                  ) : (
                    <Text variant="caption" color="textSecondary">
                      {'Will read: "'}
                      {row.after}
                      {'"'}
                    </Text>
                  )}
                </View>
              ))}
              <Button
                label={`Apply to ${applyCount} item${applyCount === 1 ? "" : "s"}`}
                disabled={busy || applyCount === 0}
                onPress={() => {
                  setBusy(true);
                  void workspace.applySharedStoryToSelected(selectedIds).finally(() => setBusy(false));
                }}
              />
            </View>
          )}
        </View>

        <Button label="Done" variant="link" onPress={onClose} />
      </View>
    </Sheet>
  );
}

export default function BulkReview(): React.ReactElement {
  const workspace = useBulkWorkspaceContext();
  const { width } = useWindowDimensions();
  const isNarrow = width < NARROW_BREAKPOINT;
  const items = listItems(workspace.state);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [expandedIndex, setExpandedIndex] = React.useState(0);

  function toggle(clientItemId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clientItemId)) next.delete(clientItemId);
      else next.add(clientItemId);
      return next;
    });
  }

  const readyCount = items.filter((i) => i.ready === true).length;
  const needDetailsCount = items.length - readyCount;

  if (items.length === 0) {
    return (
      <Page>
        <Card style={{ gap: space.md }}>
          <Eyebrow>Review</Eyebrow>
          <Text variant="displayLg">Nothing grouped yet.</Text>
          <Text variant="bodyLg" color="textSecondary">
            Head back to Photos to add and group some items first.
          </Text>
        </Card>
      </Page>
    );
  }

  const shownItems = isNarrow ? [items[Math.min(expandedIndex, items.length - 1)]].filter((i): i is BulkDraftItem => i !== undefined) : items;

  return (
    <Page>
      <View style={{ gap: space.lg }}>
        <Card style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
            <View style={{ gap: space.xxs }}>
              <Eyebrow>Review</Eyebrow>
              <TableHeading note={`${readyCount} ready · ${needDetailsCount} need details`}>{`${items.length} item${items.length === 1 ? "" : "s"}`}</TableHeading>
            </View>
            {selected.size > 0 ? <Button label={`Apply to ${selected.size} selected`} variant="secondary" onPress={() => setSheetOpen(true)} /> : null}
          </View>
          {isNarrow ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <Button label="← Prev" variant="ghost" disabled={expandedIndex <= 0} onPress={() => setExpandedIndex((i) => Math.max(0, i - 1))} />
              <Text variant="caption" color="textTertiary">
                {expandedIndex + 1} of {items.length}
              </Text>
              <Button label="Next →" variant="ghost" disabled={expandedIndex >= items.length - 1} onPress={() => setExpandedIndex((i) => Math.min(items.length - 1, i + 1))} />
            </View>
          ) : null}
        </Card>

        <View style={{ gap: space.md }}>
          {shownItems.map((item) => (
            <ItemCard key={item.clientItemId} item={item} selected={selected.has(item.clientItemId)} onToggleSelected={() => toggle(item.clientItemId)} />
          ))}
        </View>
      </View>

      <ApplyToSelectedSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} selectedIds={Array.from(selected)} />
    </Page>
  );
}
