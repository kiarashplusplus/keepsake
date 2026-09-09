// `/welcome`: the explainer as a page of its own — linkable, in the sitemap,
// with its own title and description. The explainer itself lives in
// `src/features/welcome/Explainer.tsx`, because `/` renders the same card
// for a first-time visitor (see `src/lib/firstVisit.ts` for why that is an
// in-place switch and no longer a redirect here). This route is what a
// shared "what is this?" link points at; nobody is sent here any more.
import * as React from "react";
import { Page } from "@/ui/Page";
import { RouteHead } from "@/ui/RouteHead";
import { Explainer } from "@/features/welcome/Explainer";

export default function Welcome(): React.ReactElement {
  return (
    <>
      <RouteHead
        title="Welcome"
        description="Someone nearby has something they're ready to let go of. No passwords, no money — just neighbors giving things a second life."
      />
      <Page>
        <Explainer />
      </Page>
    </>
  );
}
