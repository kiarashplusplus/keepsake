/**
 * Thin context wrapper over `useBulkWorkspace`, mounted once at
 * `app/bulk/[batchKey]/_layout.tsx` so every screen for one batch (photos,
 * review, submit) shares the same reducer, upload queue and markers rather
 * than each re-loading and re-hydrating its own copy — the same shape
 * `GiveDraftContext.tsx` gives the give flow's five steps over
 * `giveDraft.ts`, per `batchStore.ts`'s own header.
 */
import * as React from "react";
import { getStoredGrantId, setStoredGrantId } from "@/lib/bulkGrant";
import { useBulkWorkspace, type UseBulkWorkspaceResult } from "@/features/bulk/useBulkWorkspace";

const BulkWorkspaceContext = React.createContext<UseBulkWorkspaceResult | undefined>(undefined);

export function BulkWorkspaceProvider({ clientBatchKey, children }: { clientBatchKey: string; children: React.ReactNode }): React.ReactElement {
  const workspace = useBulkWorkspace(clientBatchKey, getStoredGrantId());

  // Every write in this workspace reads `grantId` off the hook's own state
  // (via `grantIdRef`, see `useBulkWorkspace.ts`), not off storage directly
  // — this effect is what keeps the persisted copy in sync so the *next*
  // batch (or a reload of this one) starts from whatever the giver last
  // entered, without every call site needing to know storage exists.
  React.useEffect(() => {
    setStoredGrantId(workspace.grantId);
  }, [workspace.grantId]);

  return <BulkWorkspaceContext.Provider value={workspace}>{children}</BulkWorkspaceContext.Provider>;
}

export function useBulkWorkspaceContext(): UseBulkWorkspaceResult {
  const ctx = React.useContext(BulkWorkspaceContext);
  if (!ctx) throw new Error("useBulkWorkspaceContext must be used within a BulkWorkspaceProvider");
  return ctx;
}
