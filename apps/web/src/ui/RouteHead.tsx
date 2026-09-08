// Per-route `<title>`/description for the exported static HTML — without
// this, every route ships the one generic title `app/+html.tsx` bakes in
// for its whole shell (see that file's OG-tags comment). `expo-router/head`
// wraps `react-helmet-async`; `apps/web/scripts/fix-html-head.mjs` already
// strips the placeholder empty `<title>` react-helmet leaves behind at
// export time, in anticipation of exactly this ("a real per-route title set
// through `expo-router/head` later will survive" — that file's comment).
//
// `" — Keepsake"` matches the format `apps/api/src/routes/item.ts` already
// bakes into `/item/:id`'s server-rewritten `<title>`, so a tab reads the
// same way whether the suffix came from there or from here.
import * as React from "react";
import Head from "expo-router/head";

export function RouteHead({ title, description }: { title: string; description?: string }): React.ReactElement {
  return (
    <Head>
      <title>{`${title} — Keepsake`}</title>
      {description !== undefined ? <meta name="description" content={description} /> : null}
    </Head>
  );
}
