/**
 * Kiarash's moderation queue. Not linked from `AppHeader` anywhere — reached
 * only by typing `/admin` — and kept out of search via both a runtime
 * `<meta name="robots">` (this file, since expo-router's static export
 * pre-renders `admin.html` once and there is no per-route way to set head
 * tags at export time the way `apps/api`'s `/item/:id` route rewrites OG
 * tags server-side) and `public/robots.txt`'s `Disallow: /admin`.
 *
 * Token entry (`AdminTokenGate`) gates everything else; once verified the
 * token lives only in `sessionStorage` (`src/lib/adminToken.ts`) and every
 * API call carries it explicitly. A 401 from any call — the token stops
 * working mid-session (rotated, mistyped, whatever) — clears it and drops
 * back to the gate with a toast, never a silent blank queue.
 */
import * as React from "react";
import { View } from "react-native";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import {
  ADMIN_QUEUE_STATUSES,
  ADMIN_REJECT_REASONS,
  type AdminQueueItem,
  type AdminQueueStatus,
  type AdminStats,
} from "@keepsake/contracts/admin";
import { MODERATION_REASONS } from "@keepsake/contracts/listing";
import { Page } from "@/ui/Page";
import { Text } from "@/ui/Text";
import { Chip } from "@/ui/Chip";
import { Button } from "@/ui/Button";
import { Stamp } from "@/ui/Stamp";
import { EmptyState } from "@/ui/EmptyState";
import { Skeleton } from "@/ui/Skeleton";
import { useToast } from "@/ui/Toast";
import { getAdminToken, setAdminToken, clearAdminToken } from "@/lib/adminToken";
import {
  approveListing,
  banOwner,
  getAdminQueue,
  getAdminStats,
  hideListing,
  rejectListing,
  restoreListing,
  unbanOwner,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import { AdminTokenGate } from "@/features/admin/AdminTokenGate";
import { StatsStrip } from "@/features/admin/StatsStrip";
import { QueueItemCard, ACTIONS_BY_STATUS } from "@/features/admin/QueueItemCard";
import { ReasonSheet } from "@/features/admin/ReasonSheet";
import { queueReducer, initialQueueState, indexOfItem } from "@/features/admin/queueReducer";

const TAB_LABELS: Record<AdminQueueStatus, string> = {
  needs_review: "Needs review",
  hidden: "Hidden",
  pending: "Pending",
  rejected: "Rejected",
};

const QUEUE_PAGE_SIZE = 20;

const REJECT_OPTIONS = ADMIN_REJECT_REASONS.map((code) => ({ value: code, label: MODERATION_REASONS[code] }));

type SheetKind = "hide" | "reject" | "ban";
type SheetState = { kind: SheetKind; item: AdminQueueItem } | null;

/** Sets/restores a `<meta name="robots">` tag for the lifetime of this
 * screen — see the file header for why this can't be done at export time. */
function useNoindex(): void {
  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = meta === null;
    if (meta === null) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "robots");
      document.head.appendChild(meta);
    }
    const previous = meta.getAttribute("content");
    meta.setAttribute("content", "noindex, nofollow");
    return () => {
      if (created) {
        meta?.remove();
      } else if (previous !== null) {
        meta?.setAttribute("content", previous);
      }
    };
  }, []);
}

export default function AdminPage(): React.ReactElement {
  useNoindex();
  const toast = useToast();

  // Lazy initializer, not an effect: `getAdminToken()` is a synchronous
  // `sessionStorage` read (guarded for the server-rendering pass this
  // static export also runs, where `window` doesn't exist — see
  // `src/lib/adminToken.ts`), so there is nothing to "load" here, just a
  // starting value React should only ever compute once.
  const [token, setToken] = React.useState<string | null>(() => getAdminToken());
  const [activeTab, setActiveTab] = React.useState<AdminQueueStatus>("needs_review");
  const [stats, setStats] = React.useState<AdminStats | null>(null);
  const [queue, dispatch] = React.useReducer(queueReducer, undefined, initialQueueState);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<SheetState>(null);
  const [sheetBusy, setSheetBusy] = React.useState(false);
  const [sheetError, setSheetError] = React.useState<string | null>(null);

  const handleSessionExpired = React.useCallback(() => {
    clearAdminToken();
    setToken(null);
    toast.show("Session expired. Enter the token again.");
  }, [toast]);

  const loadStats = React.useCallback(
    (currentToken: string) => {
      getAdminStats(currentToken)
        .then(setStats)
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) handleSessionExpired();
        });
    },
    [handleSessionExpired],
  );

  const loadTab = React.useCallback(
    (currentToken: string, status: AdminQueueStatus, append: boolean, cursor: string | undefined) => {
      dispatch({ type: "load_start", status });
      getAdminQueue(currentToken, { status, limit: QUEUE_PAGE_SIZE, ...(cursor !== undefined ? { cursor } : {}) })
        .then((page) => dispatch({ type: "load_success", status, page, append }))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            handleSessionExpired();
            return;
          }
          dispatch({ type: "load_error", status, error: err instanceof ApiError ? err.message : "Couldn't load the queue." });
        });
    },
    [handleSessionExpired],
  );

  // Verified session: load stats once, and the active tab whenever it
  // switches to one that hasn't loaded yet.
  React.useEffect(() => {
    if (token === null) return;
    loadStats(token);
    // Runs once per token, not per stats reload elsewhere on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  React.useEffect(() => {
    if (token === null) return;
    const tab = queue[activeTab];
    if (!tab.loadedOnce && !tab.loading) loadTab(token, activeTab, false, undefined);
  }, [token, activeTab, queue, loadTab]);

  function handleVerified(newToken: string): void {
    setAdminToken(newToken);
    setToken(newToken);
  }

  function handleForget(): void {
    clearAdminToken();
    setToken(null);
    setStats(null);
  }

  async function runAction(
    status: AdminQueueStatus,
    item: AdminQueueItem,
    action: () => Promise<unknown>,
    successMessage: string,
    undo?: () => void,
  ): Promise<void> {
    if (token === null) return;
    const index = indexOfItem(queue, status, item.id);
    dispatch({ type: "remove", status, id: item.id });
    setBusyId(item.id);
    try {
      await action();
      toast.show(successMessage, undo !== undefined ? { label: "Undo", onPress: undo } : undefined);
      loadStats(token);
    } catch (err) {
      dispatch({ type: "reinsert", status, item, index });
      if (err instanceof ApiError && err.status === 401) {
        handleSessionExpired();
      } else {
        toast.show(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
      }
    } finally {
      setBusyId(null);
    }
  }

  function handleApprove(item: AdminQueueItem): void {
    if (token === null) return;
    void runAction(activeTab, item, () => approveListing(token, item.id), "Approved. It's back in the feed.");
  }

  function handleRestore(item: AdminQueueItem): void {
    if (token === null) return;
    void runAction(activeTab, item, () => restoreListing(token, item.id), "Restored.", () => {
      hideListing(token, item.id).catch(() => toast.show("Undo failed — hide it again by hand."));
    });
  }

  function handleUnban(item: AdminQueueItem): void {
    if (token === null) return;
    void runAction(activeTab, item, () => unbanOwner(token, item.owner.id), "Owner unbanned.", () => {
      banOwner(token, item.owner.id).catch(() => toast.show("Undo failed — ban them again by hand."));
    });
  }

  function openSheet(kind: SheetKind, item: AdminQueueItem): void {
    setSheetError(null);
    setSheet({ kind, item });
  }

  /**
   * Unlike `runAction` (optimistic: remove first, reinsert on failure), a
   * reason-gated action waits for the real API call before touching the
   * queue at all — the reason has to actually be accepted server-side
   * (`ADMIN_REJECT_REASONS` enum, etc.) before there's anything to be
   * optimistic about, and the sheet is already showing a spinner/blocking
   * the UI in the meantime.
   */
  async function handleSheetConfirm(reason: string | undefined): Promise<void> {
    if (sheet === null || token === null) return;
    const { kind, item } = sheet;
    setSheetBusy(true);
    setSheetError(null);
    try {
      if (kind === "hide") {
        await hideListing(token, item.id, reason !== undefined ? { reason } : {});
        dispatch({ type: "remove", status: activeTab, id: item.id });
        setSheet(null);
        toast.show("Hidden.", {
          label: "Undo",
          onPress: () => {
            restoreListing(token, item.id).catch(() => toast.show("Undo failed — restore it by hand."));
          },
        });
        loadStats(token);
        return;
      }
      if (kind === "ban") {
        await banOwner(token, item.owner.id, reason !== undefined ? { reason } : {});
        dispatch({ type: "remove", status: activeTab, id: item.id });
        setSheet(null);
        toast.show("Owner banned.", {
          label: "Undo",
          onPress: () => {
            unbanOwner(token, item.owner.id).catch(() => toast.show("Undo failed — unban them by hand."));
          },
        });
        loadStats(token);
        return;
      }
      // reject: `reason` is required (enforced by ReasonSheet's enum mode).
      if (reason === undefined) return;
      await rejectListing(token, item.id, { reason: reason as (typeof ADMIN_REJECT_REASONS)[number] });
      dispatch({ type: "remove", status: activeTab, id: item.id });
      setSheet(null);
      toast.show("Rejected.");
      loadStats(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSheet(null);
        handleSessionExpired();
        return;
      }
      setSheetError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setSheetBusy(false);
    }
  }

  if (token === null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.loose }}>
        <AdminTokenGate onVerified={handleVerified} />
      </Page>
    );
  }

  const tab = queue[activeTab];
  const actions = ACTIONS_BY_STATUS[activeTab];

  return (
    <Page variant="grid" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.xl }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
        <Text variant="displayLg">Admin</Text>
        <Button label="Forget" variant="ghost" onPress={handleForget} />
      </View>

      <StatsStrip stats={stats} />

      <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {ADMIN_QUEUE_STATUSES.map((status) => (
          <Chip key={status} label={TAB_LABELS[status]} selected={activeTab === status} onPress={() => setActiveTab(status)} />
        ))}
      </View>

      {tab.error !== null ? (
        <Text variant="body" color="dangerText">
          {tab.error}
        </Text>
      ) : null}

      {tab.loading && tab.items.length === 0 ? <Skeleton height={240} /> : null}

      {!tab.loading && tab.loadedOnce && tab.items.length === 0 ? (
        <EmptyState title="Nothing waiting." line="The queue is clear for now." ornament={<Stamp state="idle" label="clear" />} />
      ) : null}

      <View style={{ gap: space.lg }}>
        {tab.items.map((item) => (
          <QueueItemCard
            key={item.id}
            item={item}
            actions={actions}
            busy={busyId === item.id}
            onApprove={() => handleApprove(item)}
            onHide={() => openSheet("hide", item)}
            onRestore={() => handleRestore(item)}
            onReject={() => openSheet("reject", item)}
            onBanOwner={() => openSheet("ban", item)}
            onUnbanOwner={() => handleUnban(item)}
          />
        ))}
      </View>

      {tab.cursor !== null ? (
        <View style={{ flexDirection: "row", justifyContent: "center" }}>
          <Button label="More" variant="secondary" loading={tab.loading} disabled={tab.loading} onPress={() => loadTab(token, activeTab, true, tab.cursor ?? undefined)} />
        </View>
      ) : null}

      <ReasonSheet
        visible={sheet !== null && sheet.kind === "hide"}
        onClose={() => setSheet(null)}
        title="Hide this listing?"
        confirmLabel="Hide"
        mode="text"
        busy={sheetBusy}
        error={sheetError}
        onConfirm={(reason) => void handleSheetConfirm(reason)}
      />
      <ReasonSheet
        visible={sheet !== null && sheet.kind === "ban"}
        onClose={() => setSheet(null)}
        title="Ban this owner?"
        confirmLabel="Ban"
        mode="text"
        busy={sheetBusy}
        error={sheetError}
        onConfirm={(reason) => void handleSheetConfirm(reason)}
      />
      <ReasonSheet
        visible={sheet !== null && sheet.kind === "reject"}
        onClose={() => setSheet(null)}
        title="Reject this listing"
        confirmLabel="Reject"
        mode="enum"
        options={REJECT_OPTIONS}
        busy={sheetBusy}
        error={sheetError}
        onConfirm={(reason) => void handleSheetConfirm(reason)}
      />
    </Page>
  );
}
