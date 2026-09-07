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
  type AdminHealth,
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
  getAdminHealth,
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
import { Observatory } from "@/features/admin/Observatory";
import { QueueItemCard, ACTIONS_BY_STATUS } from "@/features/admin/QueueItemCard";
import { BulkActionBar } from "@/features/admin/BulkActionBar";
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

/** Coalesces however many actions land in a burst (a keyboard sweep, a bulk
 * action) into one `GET /api/admin/stats` — that endpoint runs three
 * full-table `COUNT`s (issue #11), so firing it after every single approve/
 * hide/reject is the queue's own biggest source of needless load at the
 * exact moment it's already busiest. */
const STATS_REFRESH_DEBOUNCE_MS = 2_500;

type SheetKind = "hide" | "reject" | "ban" | "approve";
/** `single` mirrors a click on one card's own button. `bulk` is the
 * selection toolbar's doing — same sheet, same confirmation copy pattern,
 * just acting on every id in the set instead of one `item`. */
type SheetTarget = { scope: "single"; item: AdminQueueItem } | { scope: "bulk"; ids: string[] };
type SheetState = { kind: SheetKind; target: SheetTarget } | null;

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
  // Top-level section, separate from `activeTab` below (the queue's own
  // status filter). The queue is the default and has to stay that way —
  // `Observatory` isn't rendered at all until this flips, which is what
  // keeps it from costing the default view a request it never asked for;
  // see `Observatory.tsx`'s own file header on why that's enough on its own
  // without a second "loaded" flag or a `React.lazy` split.
  const [activeSection, setActiveSection] = React.useState<"queue" | "observatory">("queue");
  const [activeTab, setActiveTab] = React.useState<AdminQueueStatus>("needs_review");
  const [stats, setStats] = React.useState<AdminStats | null>(null);
  const [health, setHealth] = React.useState<AdminHealth | null>(null);
  const [healthAsOf, setHealthAsOf] = React.useState<number | null>(null);
  const [queue, dispatch] = React.useReducer(queueReducer, undefined, initialQueueState);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<SheetState>(null);
  const [sheetBusy, setSheetBusy] = React.useState(false);
  const [sheetError, setSheetError] = React.useState<string | null>(null);
  // Bulk selection, independent of which row the keyboard's roving focus is
  // on — a card can be checked without being the one shortcuts act on.
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(new Set());
  // Index into the *active tab's* items, not a stable id: `j`/`k` (or the
  // arrow keys) below move this, and `a`/`h`/`r` act on whichever row it
  // currently points at.
  const [focusedIndex, setFocusedIndex] = React.useState(0);

  const tab = queue[activeTab];
  const actions = ACTIONS_BY_STATUS[activeTab];

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

  // Fetched alongside stats, not folded into `loadStats`: `AdminHealth` and
  // `AdminStats` are two separate endpoints and either one failing shouldn't
  // block the other from rendering.
  const loadHealth = React.useCallback(
    (currentToken: string) => {
      getAdminHealth(currentToken)
        .then((data) => {
          // Captured here, in the fetch's own callback, rather than inside
          // `StatsStrip`'s render: that's the one place this timestamp is
          // allowed to be read impurely (see `StatsStripProps.healthAsOf`'s
          // doc comment).
          setHealth(data);
          setHealthAsOf(Date.now());
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) handleSessionExpired();
        });
    },
    [handleSessionExpired],
  );

  // See `STATS_REFRESH_DEBOUNCE_MS`'s doc comment: every call site that used
  // to fire `loadStats` right after an action fires this instead, so a
  // keyboard sweep or a bulk action costs one stats fetch, not one per item.
  const statsRefreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStatsRefresh = React.useCallback(
    (currentToken: string) => {
      if (statsRefreshTimer.current !== null) clearTimeout(statsRefreshTimer.current);
      statsRefreshTimer.current = setTimeout(() => {
        statsRefreshTimer.current = null;
        loadStats(currentToken);
      }, STATS_REFRESH_DEBOUNCE_MS);
    },
    [loadStats],
  );
  React.useEffect(() => {
    return () => {
      if (statsRefreshTimer.current !== null) clearTimeout(statsRefreshTimer.current);
    };
  }, []);

  // A tab switch starts both clean: a selection or a roving-focus position
  // from the Hidden tab means nothing once you're looking at Needs review.
  // Render-phase comparison against the previous value, not an effect — same
  // "adjusting state when something changes" pattern (and the same lint
  // rule driving it) as `ReasonSheet.tsx`'s own doc comment explains.
  const [previousActiveTab, setPreviousActiveTab] = React.useState(activeTab);
  if (activeTab !== previousActiveTab) {
    setPreviousActiveTab(activeTab);
    setSelectedIds(new Set());
    setFocusedIndex(0);
  }

  // Keeps the roving focus in range as rows leave the tab (approve/hide/
  // reject, single or bulk) — otherwise it can point one past the end.
  const [previousItemCount, setPreviousItemCount] = React.useState(tab.items.length);
  if (tab.items.length !== previousItemCount) {
    setPreviousItemCount(tab.items.length);
    if (tab.items.length === 0) {
      setFocusedIndex(0);
    } else if (focusedIndex > tab.items.length - 1) {
      setFocusedIndex(tab.items.length - 1);
    }
  }

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
    loadHealth(token);
    // Runs once per token, not per stats/health reload elsewhere on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  React.useEffect(() => {
    if (token === null) return;
    const activeTabState = queue[activeTab];
    if (!activeTabState.loadedOnce && !activeTabState.loading) loadTab(token, activeTab, false, undefined);
  }, [token, activeTab, queue, loadTab]);

  function handleVerified(newToken: string): void {
    setAdminToken(newToken);
    setToken(newToken);
  }

  function handleForget(): void {
    clearAdminToken();
    setToken(null);
    setStats(null);
    setHealth(null);
    setHealthAsOf(null);
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
      scheduleStatsRefresh(token);
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
    setSheet({ kind, target: { scope: "single", item } });
  }

  function openBulkSheet(kind: SheetKind): void {
    if (selectedIds.size === 0) return;
    setSheetError(null);
    setSheet({ kind, target: { scope: "bulk", ids: Array.from(selectedIds) } });
  }

  function toggleSelect(id: string): void {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Runs one admin call per id, sequentially (a moderation queue's bulk
   * selections are dozens at most, not thousands, and sequential means a
   * session that expires mid-sweep stops immediately instead of 401ing on
   * every remaining id). Stops early on a 401 — every other error just
   * counts against `failed` so one bad row doesn't block the rest.
   */
  async function runBulk(ids: string[], action: (id: string) => Promise<unknown>): Promise<{ succeeded: string[]; failed: number; sessionExpired: boolean }> {
    const succeeded: string[] = [];
    let failed = 0;
    for (const id of ids) {
      try {
        await action(id);
        succeeded.push(id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return { succeeded, failed, sessionExpired: true };
        }
        failed += 1;
      }
    }
    return { succeeded, failed, sessionExpired: false };
  }

  /**
   * Unlike `runAction` (optimistic: remove first, reinsert on failure), a
   * reason-gated action waits for the real API call before touching the
   * queue at all — the reason has to actually be accepted server-side
   * (`ADMIN_REJECT_REASONS` enum, etc.) before there's anything to be
   * optimistic about, and the sheet is already showing a spinner/blocking
   * the UI in the meantime. Bulk actions go through here too, `target.scope`
   * branching only where the two genuinely differ.
   */
  async function handleSheetConfirm(reason: string | undefined): Promise<void> {
    if (sheet === null || token === null) return;
    const { kind, target } = sheet;

    if (target.scope === "bulk") {
      // Reject's reason is required (`ReasonSheet`'s enum mode enforces
      // this in single-item mode too) — bail before touching the network
      // rather than firing N calls that would each 400.
      if (kind === "reject" && reason === undefined) return;
      setSheetBusy(true);
      setSheetError(null);
      const { ids } = target;
      const { succeeded, failed, sessionExpired } = await runBulk(ids, (id) => {
        if (kind === "hide") return hideListing(token, id, reason !== undefined ? { reason } : {});
        if (kind === "approve") return approveListing(token, id);
        return rejectListing(token, id, { reason: reason as (typeof ADMIN_REJECT_REASONS)[number] });
      });
      setSheetBusy(false);
      if (sessionExpired) {
        setSheet(null);
        handleSessionExpired();
        return;
      }
      if (succeeded.length > 0) {
        dispatch({ type: "remove_many", status: activeTab, ids: succeeded });
        setSelectedIds((previous) => {
          const next = new Set(previous);
          for (const id of succeeded) next.delete(id);
          return next;
        });
      }
      setSheet(null);
      const verb = kind === "hide" ? "Hidden" : kind === "approve" ? "Approved" : "Rejected";
      toast.show(failed === 0 ? `${verb} ${succeeded.length}.` : `${verb} ${succeeded.length} of ${ids.length} — ${failed} failed.`);
      scheduleStatsRefresh(token);
      return;
    }

    const { item } = target;
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
        scheduleStatsRefresh(token);
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
        scheduleStatsRefresh(token);
        return;
      }
      // reject: `reason` is required (enforced by ReasonSheet's enum mode).
      if (reason === undefined) return;
      await rejectListing(token, item.id, { reason: reason as (typeof ADMIN_REJECT_REASONS)[number] });
      dispatch({ type: "remove", status: activeTab, id: item.id });
      setSheet(null);
      toast.show("Rejected.");
      scheduleStatsRefresh(token);
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

  // Keyboard path for the queue: j/k (or the arrow keys) move the roving
  // focus, x/Space toggles the focused row into the bulk selection, and
  // a/h/r fire the same actions their on-screen buttons do. Skipped whole
  // cloth while a sheet is open (it has its own Escape/Tab handling) or
  // while the target is a real text field, so this never steals a keystroke
  // meant for the reason textarea or a future search box.
  React.useEffect(() => {
    if (token === null) return undefined;
    if (typeof document === "undefined") return undefined;

    function onKeyDown(event: KeyboardEvent): void {
      // The Observatory tab has no roving focus or sheet of its own — these
      // are the queue's shortcuts, and firing them into rows the admin can't
      // currently see would move `focusedIndex`/act on a card with no
      // visible feedback at all.
      if (activeSection !== "queue") return;
      if (sheet !== null) return;
      const eventTarget = event.target;
      if (eventTarget instanceof HTMLElement) {
        const tag = eventTarget.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || eventTarget.isContentEditable) return;
      }

      const items = tab.items;
      if (items.length === 0) return;

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setFocusedIndex((index) => Math.min(index + 1, items.length - 1));
        return;
      }
      if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setFocusedIndex((index) => Math.max(index - 1, 0));
        return;
      }

      const focusedItem = items[focusedIndex];
      if (focusedItem === undefined) return;

      if (event.key === "x" || event.key === " ") {
        event.preventDefault();
        toggleSelect(focusedItem.id);
        return;
      }
      if (event.key === "a" && actions.approve) {
        event.preventDefault();
        handleApprove(focusedItem);
        return;
      }
      if (event.key === "h" && actions.hide) {
        event.preventDefault();
        openSheet("hide", focusedItem);
        return;
      }
      if (event.key === "r" && actions.reject) {
        event.preventDefault();
        openSheet("reject", focusedItem);
        return;
      }
      if (event.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(new Set());
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `handleApprove`/`openSheet`/`toggleSelect` are plain functions redefined every render; listing the state and derived values they close over is what actually keeps this current.
  }, [token, activeSection, sheet, tab, focusedIndex, actions, selectedIds]);

  if (token === null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.loose }}>
        <AdminTokenGate onVerified={handleVerified} />
      </Page>
    );
  }

  return (
    <Page variant="grid" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.xl }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
        <Text variant="displayLg">Admin</Text>
        <Button label="Forget" variant="ghost" onPress={handleForget} />
      </View>

      <StatsStrip stats={stats} health={health} healthAsOf={healthAsOf} />

      {/* Top-level section switch. "Queue" stays the default (`activeSection`'s
          initializer above) and everything below it is unchanged from before
          this panel existed; "Observatory" only mounts `<Observatory>` once
          picked, so the default view never pays for the extra fetch. */}
      <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <Chip role="tab" label="Queue" selected={activeSection === "queue"} onPress={() => setActiveSection("queue")} />
        <Chip role="tab" label="Observatory" selected={activeSection === "observatory"} onPress={() => setActiveSection("observatory")} />
      </View>

      {activeSection === "queue" ? (
        <>
          <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {ADMIN_QUEUE_STATUSES.map((status) => (
              <Chip key={status} role="tab" label={TAB_LABELS[status]} selected={activeTab === status} onPress={() => setActiveTab(status)} />
            ))}
          </View>

          <BulkActionBar
            count={selectedIds.size}
            actions={actions}
            onApprove={() => openBulkSheet("approve")}
            onHide={() => openBulkSheet("hide")}
            onReject={() => openBulkSheet("reject")}
            onClear={() => setSelectedIds(new Set())}
          />

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
            {tab.items.map((item, index) => (
              <QueueItemCard
                key={item.id}
                item={item}
                actions={actions}
                busy={busyId === item.id}
                focused={index === focusedIndex}
                selected={selectedIds.has(item.id)}
                onToggleSelect={() => toggleSelect(item.id)}
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
        </>
      ) : (
        <Observatory token={token} onSessionExpired={handleSessionExpired} />
      )}

      <ReasonSheet
        visible={sheet !== null && sheet.kind === "hide"}
        onClose={() => setSheet(null)}
        title={sheet !== null && sheet.target.scope === "bulk" ? `Hide ${sheet.target.ids.length} listings?` : "Hide this listing?"}
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
        title={sheet !== null && sheet.target.scope === "bulk" ? `Reject ${sheet.target.ids.length} listings` : "Reject this listing"}
        confirmLabel="Reject"
        mode="enum"
        options={REJECT_OPTIONS}
        busy={sheetBusy}
        error={sheetError}
        onConfirm={(reason) => void handleSheetConfirm(reason)}
      />
      {/* Approve has no single-item sheet (it's already one click) — this
          only ever opens from the bulk toolbar, and exists purely so a
          destructive-scale action ("send 40 listings back into the public
          feed at once") states the count before it fires. */}
      <ReasonSheet
        visible={sheet !== null && sheet.kind === "approve" && sheet.target.scope === "bulk"}
        onClose={() => setSheet(null)}
        title={sheet !== null && sheet.target.scope === "bulk" ? `Approve ${sheet.target.ids.length} listings?` : "Approve"}
        confirmLabel="Approve"
        mode="confirm"
        message="They'll go back in the public feed."
        busy={sheetBusy}
        error={sheetError}
        onConfirm={() => void handleSheetConfirm(undefined)}
      />
    </Page>
  );
}
