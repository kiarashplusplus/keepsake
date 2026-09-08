// One batch's workspace: mounts `BulkWorkspaceProvider` for the whole
// sub-stack (photos / review / submit — see `app/give/_layout.tsx`'s
// identical shape for the give flow) and renders the load-time states
// (`loading`/`not_found`/`unavailable`) once here rather than in every
// screen underneath.
import * as React from "react";
import { View } from "react-native";
import { Link, Stack, useLocalSearchParams, usePathname } from "expo-router";
import { space } from "@keepsake/tokens/spacing";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Card } from "@/ui/Surface";
import { Text } from "@/ui/Text";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { Stamp } from "@/ui/Stamp";
import { Page } from "@/ui/Page";
import { BulkWorkspaceProvider, useBulkWorkspaceContext } from "@/features/bulk/BulkWorkspaceContext";

const TABS: { path: string; label: string }[] = [
  { path: "photos", label: "Photos" },
  { path: "review", label: "Review" },
  { path: "submit", label: "Submit" },
];

function Tabs({ batchKey }: { batchKey: string }): React.ReactElement {
  const pathname = usePathname();
  return (
    <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
      {TABS.map((tab) => {
        const active = pathname.endsWith(`/${tab.path}`);
        return (
          <Link key={tab.path} href={{ pathname: `/bulk/[batchKey]/${tab.path}` as const, params: { batchKey } }} asChild>
            <Text
              variant="label"
              color={active ? "accentText" : "ink"}
              style={{ fontSize: 12, textDecorationLine: active ? "underline" : "none" }}
              accessibilityRole="link"
            >
              {tab.label}
            </Text>
          </Link>
        );
      })}
    </View>
  );
}

function WorkspaceShell({ batchKey, children }: { batchKey: string; children: React.ReactNode }): React.ReactElement {
  const workspace = useBulkWorkspaceContext();

  if (workspace.status === "loading") {
    return (
      <Page variant="prose">
        <View style={{ gap: space.md }}>
          <Skeleton height={56} />
          <Skeleton height={200} />
        </View>
      </Page>
    );
  }

  if (workspace.status === "not_found") {
    return (
      <Page variant="prose">
        <EmptyState
          ornament={<Stamp state="idle" label="Gone" />}
          eyebrow="Give several items"
          title="This batch isn't on this device."
          line="If you started it on another browser, add a verified email under Mine so your batches follow you — or start a new one."
          action={
            <Link href="/bulk" asChild>
              <Text variant="label" color="accentText" accessibilityRole="link">
                Back to your batches
              </Text>
            </Link>
          }
        />
      </Page>
    );
  }

  if (workspace.status === "unavailable") {
    return (
      <Page variant="prose">
        <EmptyState eyebrow="Give several items" title="Not open on this build yet." line="Estate clear-out batches are a pilot feature." />
      </Page>
    );
  }

  return (
    <ReadableWidth variant="prose" style={{ flex: 1, paddingVertical: space.xxl, gap: space.xl }}>
      <Card style={{ gap: space.sm, transform: [{ rotate: "0.3deg" }] }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm }}>
          <Link href="/bulk" accessibilityRole="link" style={{ flexShrink: 0 }}>
            <Text variant="label" color="ink" style={{ fontSize: 12 }}>
              ← Your batches
            </Text>
          </Link>
          <Text variant="caption" color="textTertiary" numberOfLines={1} style={{ flexShrink: 1, textAlign: "right" }}>
            {workspace.state.batch.name}
          </Text>
        </View>
        <Tabs batchKey={batchKey} />
        {workspace.uploadPausedUntil !== null ? (
          <Text variant="caption" color="foilText">
            {"Pausing uploads for a moment — they'll pick back up on their own."}
          </Text>
        ) : null}
      </Card>
      <View style={{ flex: 1 }}>{children}</View>
    </ReadableWidth>
  );
}

export default function BulkBatchLayout(): React.ReactElement {
  const { batchKey } = useLocalSearchParams<{ batchKey: string }>();
  return (
    <BulkWorkspaceProvider clientBatchKey={batchKey}>
      <WorkspaceShell batchKey={batchKey}>
        <Stack screenOptions={{ headerShown: false }} />
      </WorkspaceShell>
    </BulkWorkspaceProvider>
  );
}
