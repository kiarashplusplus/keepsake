# Microsoft Advertising: the plan for turning ads on (2026-09-10)

**Status: a plan, not a change.** Nothing in this document is live. It exists so that the switch
from "no ads" to "Microsoft Advertising, consent-gated" happens in the order the codebase and the
legal docs demand, rather than the order the Google Ads attempt took — where the code, the
variables, the deploy and the privacy page each described a different state and nothing
reconciled them (#175, #299).

Google Ads was never run. The plumbing for it was written, never fed a tag id by any deploy, and
removed on 2026-09-07 (Kiarash's decision, #175). What survived is a consent framework with an
advertising category that loads nothing. This plan re-uses that framework for Microsoft
Advertising's Universal Event Tracking (UET) tag and re-uses the two conversions the Google
design had — a listing going live, a request being sent — without restoring anything Google.

**Not legal advice.** The legal section below is a reading of this repo's own legal documents
against what the tag does, and says what has to change in them. It does not settle the questions
those documents leave open.

---

## 0. What the tag is, and the facts the rest rests on

Microsoft's UET tag is one script per site, one numeric tag id, and custom events pushed onto
`window.uetq`. Conversion goals are defined in the Microsoft Advertising UI against those events.
Facts checked on 2026-09-10 (Microsoft's help center is a JavaScript app the container cannot
render, so the sources are the docs repo and Microsoft Q&A; marked **[summary-sourced]** where
only a search summary was readable):

| Fact | Value | Why it matters here |
| --- | --- | --- |
| Script host | `https://bat.bing.com/bat.js` | goes in `script-src`, both CSP copies |
| Second host | `https://bat.bing.net` | Microsoft's CSP guidance lists both hosts in `script-src`, `img-src` and `connect-src`; a policy with only `bat.bing.com` has been reported to drop events since consent mode shipped |
| Reporting | image beacons and fetches to `bat.bing.com/action/0?…` (and `.net`) | `img-src` and `connect-src` both need both hosts — the exact failure `analyticsCsp.test.ts` was written for |
| Tag id shape | numeric, e.g. `12345678` | the kill-switch regex is `/^\d{6,12}$/`, not `/^(AW\|G\|GT)-/` |
| Consent mode | `uetq.push('consent','default',{ad_storage:'denied'})` before load; `uetq.push('consent','update',{ad_storage:'granted'})` on grant | **[summary-sourced]** If no default is set the tag assumes granted. Under `denied`, first-party cookies are not read or written |
| First-party cookies | `_uetsid` (session, ~1 day), `_uetvid` (visitor, ~1 year), `_uetmsclkid` (click id, ~90 days) | **[summary-sourced]** Named on the privacy page; cleared by `deleteCookies(['_uet'])` on withdrawal |
| Third-party cookie | `MUID` on `bing.com`, ~1 year | Set by Microsoft, not by this site; cannot be cleared from here; named on the privacy page as such |
| Click id | `msclkid` query parameter, auto-tagging on by default | the first-visit rule in `app/+html.tsx` keys on `q` only, so `?msclkid=` still shows the explainer — no change needed |
| Google import | campaigns import; **conversion goals and tracking do not** — UET must be installed and goals created by hand | there are no Google campaigns to import anyway |
| Inline snippet | Microsoft's snippet is inline JS and their CSP page recommends a nonce | **not applicable**: `consent.js` injects `bat.js` as an external script and constructs `UET` itself, so no inline script, no nonce, no new `script-src` hash |

Sources: [Microsoft CSP guidance for UET](https://github.com/MicrosoftDocs/Advertising/blob/main/advertising/msa-help/hlp_BA_CONC_UETv2CSP.md) ·
[bat.bing.net Q&A](https://learn.microsoft.com/en-us/answers/questions/2289073/bat-bing-net-is-there-a-new-microsoft-ads-domain) ·
[UET consent FAQ](https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_conc_uet_consentfaq) ·
[MSCLKID auto-tagging](https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_proc_microsoftclickid) ·
[UET overview](https://learn.microsoft.com/en-us/advertising/guides/universal-event-tracking).

## 1. Decisions to make before any of this starts

These are Kiarash's calls. The rest of the plan assumes the recommended answer; a different
answer changes the legal section, not just the code.

1. **Measurement only, no remarketing.** Create no remarketing lists, no audiences, no "similar
   audiences". UET still sets `_uetvid`, but nothing on Microsoft's side is built from it. This
   keeps the privacy page's "no profiling" posture, keeps the Montana minors constraint
   (`legal-open-questions-research.md` Q3 item 2: targeted advertising to minors needs consent;
   contextual does not) out of play, and is the honest version of "we only want to know which
   advert brought you here". **Recommended: yes.**
2. **Two conversions, same as the Google design:** `give_live` (a listing approved and public,
   fired from `app/give/review.tsx` where `AnalyticsEvents.GiveLive` already fires) and
   `request_sent` (from `RequestSheet.tsx` where `AnalyticsEvents.RequestSent` fires). No value,
   no currency, no listing id, no email — the event carries a name and nothing else.
   **Recommended: yes.**
3. **One tag id per tier, or one for both.** A separate UET tag for preview keeps Kiarash's own
   test traffic out of the conversion counts. Microsoft allows several tags per account.
   **Recommended: two tags**, `EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID` set differently in the
   `preview` and `production` GitHub Environments.
4. **Re-prompt everyone.** The advertising category's banner text today is "Nothing here today —
   Keepsake loads no advertising tag." A visitor who pressed "Accept all" accepted that
   description. `consent.js`'s own rule is "bump `CONSENT_VERSION` when a category changes
   meaning", and the privacy page promises "If we ever change what the groups mean, we'll ask you
   again". So `CONSENT_VERSION` goes to 2 and every visitor sees the banner once more.
   **Not optional** — the page has promised it.
5. **Geo-targeting matches the geo-block.** Campaigns target the US and Canada only. The UK is
   451'd at the edge (`docs/runbooks/uk-block.md`), so a UK click is paid for and then refused.
6. **No user photos in ad creative.** `terms.html`'s content licence says "Not in adverts, not on
   another site" and promises to ask first. Stock or own photography only; if a listing photo is
   ever wanted, that paragraph changes before the creative runs, and the giver is asked.

## 2. Microsoft Advertising setup (off the computer, Kiarash)

In this order, because step 4 produces the id the code needs and steps 6 and 7 depend on the
code being live.

1. Create the Microsoft Advertising account (or sign in). Business details as the sole
   proprietorship; the DBA question in `legal-next-actions-research.md` §4 is unchanged by this.
2. **Skip "Import from Google Ads."** There are no Google campaigns; and even with some, conversion
   tracking does not import — it has to be UET. If a Google account with draft campaigns exists,
   import once, review, and note that the importer converts bid strategies to maximise-clicks and
   overwrites edits on every scheduled re-import; do not schedule one.
3. Account settings → confirm **"Add Microsoft Click ID (MSCLKID) to URLs"** is on (it is by
   default). Nothing in the app has to handle the parameter.
4. Conversion tracking → **create a UET tag** named `keepsake-production`; create a second,
   `keepsake-preview`. Record both numeric ids. These are public values (they ship in page
   source) — they go in GitHub Environment *variables*, never secrets, and nowhere in the repo.
5. Conversion goals, both **Event** goals on the production tag: `give_live` and `request_sent`,
   matched on the event action, category `conversion`, count **unique** per session, value none.
   Attribution: last click is fine at this size. Create the same two on the preview tag so the
   preview deploy can be checked end to end.
6. **Campaign** — one search campaign, US + Canada, English, manual CPC or maximise clicks with a
   ceiling, a daily budget Kiarash is comfortable losing in a week. Keywords around "give away
   sentimental items", "free stuff near me", "rehome heirloom"; negatives for "sell", "price",
   "worth". Ad copy: no claims the product cannot back (no "verified", no "safe" — see
   `terms.html`'s disclaimer). Landing page `/` — the explainer already shows to a first visit.
7. **Only after the code in §3 is deployed and verified (§5)**, set the campaign live. Tag
   status in the UI reads "Tag active" once it has seen a page load, which cannot happen until a
   visitor has granted the advertising category.

## 3. Code changes, in one pull request

One PR, because the guards only pass when every half moves together — that is what they are for.
Tests that currently pin the "no ads" state are listed with their new assertion so nothing is
deleted to make CI green.

### 3.1 The variable — four places, together (#175's rule)

| Where | Change |
| --- | --- |
| `.env.example` | declare `EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID=` in the `EXPO_PUBLIC_*` block with a comment saying it is a public value and empty means nothing loads. The comment already there ("a name in this block is a promise that the deploy passes it") stays and becomes true |
| `.github/workflows/deploy.yml` | add `EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID: ${{ vars.EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID }}` to the "Export web" step; rewrite the comment that says "four names again" |
| GitHub Environments `preview` and `production` | set the variable **before merging** — `verify-public-env.mjs` fails a deployed export when a declared name is unset, so a merge before the value exists breaks the next preview deploy |
| `apps/web/src/lib/config.ts` | `microsoftAdsTagId: process.env.EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID ?? ""` and the long comment explaining the Google removal rewritten into a shorter one pointing here |

Name chosen to avoid `TOKEN|KEY`, so it needs no allowlist entry in `publicEnv.test.ts` or
preflight's `public-env`. Preflight's `public-env-passthrough` will fail until `deploy.yml` passes
it, which is the point. The preflight test "no `EXPO_PUBLIC_GOOGLE_ADS_*` survives" stays as it
is — Google is not coming back.

### 3.2 `apps/web/public/consent.js` — the provider swap

- `PROVIDERS`: replace the Google entry with
  `{ category: 'advertising', name: 'Microsoft Advertising', host: 'bat.bing.com', meta: 'ks-microsoft-ads-id', beacon: ['https://bat.bing.com', 'https://bat.bing.net'] }`.
  `beacon` becomes an array; `analyticsCsp.test.ts` is extended to accept one (§3.5).
- `applyAdvertising(granted)`:
  - read `ks-microsoft-ads-id`; kill switch `if (!/^\d{6,12}$/.test(id)) return;` — an empty
    value and an unsubstituted `%EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID%` both fail it, as today.
  - `window.uetq = window.uetq || []` and, once, `uetq.push('consent','default',{ad_storage:'denied'})`.
  - on grant: `uetq.push('consent','update',{ad_storage:'granted'})`, then
    `injectScript('https://bat.bing.com/bat.js')` with an `onload` that does
    `var o = { ti: id, enableAutoSpaTracking: true }; o.q = window.uetq; window.uetq = new UET(o); window.uetq.push('pageLoad');`
    `enableAutoSpaTracking` matters because expo-router changes routes without a page load.
  - on withdrawal after a load: `uetq.push('consent','update',{ad_storage:'denied'})` and
    `deleteCookies(['_uet'])`. `MUID` lives on `bing.com` and cannot be cleared from here.
- `gtagShim` and the `_gcl/_gac/_ga` cookie list go. Nothing else references them.
- `CONSENT_VERSION = 2`, with the `v2 =` line in the comment above it: "advertising now loads the
  Microsoft Advertising tag on a grant". `e2e/support/consent.ts` reads the number out of this
  file, so the fixtures follow.
- The advertising `categoryRow` description: "Microsoft Advertising measurement, so we can tell
  which advert brought you here. Off unless you say yes." The #299 guard checks that a category
  description never names a provider whose meta is hardcoded empty; once the meta carries a
  placeholder that a deploy fills, naming the provider is allowed and correct.

### 3.3 The meta tag, on every page

- `apps/web/app/+html.tsx`: replace `<meta name="ks-google-ads-id" content="" />` with
  `{config.microsoftAdsTagId ? <meta name="ks-microsoft-ads-id" content={config.microsoftAdsTagId} /> : null}`
  — the same shape the Cloudflare beacon uses, and the shape the guards understand.
- `apps/site/public/{about,privacy,terms}.html`: replace the empty Google meta with
  `<meta name="ks-microsoft-ads-id" content="%EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID%" />` and replace
  the HTML comment beside it (it explains the Google kill switch and points at the Rhode Island
  paragraph; the new one points at §4 of this document).
- `apps/web/scripts/copy-site.mjs`: add the name to `SUBSTITUTIONS`. The placeholder check at the
  bottom then fails a deployed export that forgot the variable — the second guard #175 added.

### 3.4 CSP — both copies, byte-identical

`apps/web/public/_headers` and `apps/api/src/middleware/securityHeaders.ts`:

- `script-src`: remove `https://www.googletagmanager.com`, add `https://bat.bing.com https://bat.bing.net`.
- `connect-src`: add `https://bat.bing.com https://bat.bing.net`.
- `img-src`: add `https://bat.bing.com https://bat.bing.net`.

No hash changes — `consent.js` is an external file and the injected tag is an external file.
Preflight's `csp-script-hash` is unaffected. The `_headers` comment and `ops.md` §CSP mention the
tag-manager host by name; update the prose.

### 3.5 The two conversions

A small module, `apps/web/src/lib/adsEvents.ts` (the name the deleted one had, so the comments
that mention it become true again):

```ts
export function reportConversion(name: "give_live" | "request_sent"): boolean {
  if (!isAdvertisingAllowed()) return false;
  // Before bat.js loads `uetq` is a plain array; after, it is a UET instance.
  // Both have `push`, and consent.js is the only thing that creates either.
  const q = (window as { uetq?: { push?: (...args: unknown[]) => void } }).uetq;
  if (typeof q?.push !== "function") return false;
  q.push("event", name, { event_category: "conversion" });
  return true;
}
```

Called once each, next to the existing `track(AnalyticsEvents.GiveLive)` in `app/give/review.tsx`
and `track(AnalyticsEvents.RequestSent)` in `features/request/RequestSheet.tsx`, replacing the
two comments that say the Google conversion was removed. It checks consent at call time, as
`track()` does, because a visitor can withdraw mid-session. Web-only by construction: `window`
absent means false, which is what the static render sees.

### 3.6 Tests: what changes, and what each now asserts

| File | Today | After |
| --- | --- | --- |
| `test/lib/consent.test.ts` "the gate" | sets `ks-google-ads-id: AW-…`, expects `googletagmanager.com` | sets `ks-microsoft-ads-id: 12345678`, expects `bat.bing.com`; new cases: a non-numeric id loads nothing; `uetq` receives `consent default denied` before load, `update granted` on grant, `update denied` plus `_uet*` cookies cleared on withdrawal. The "#175 empty meta" case becomes "an absent meta loads nothing", which is the same code path |
| `test/guards/privacyPolicy.test.ts` "#175" block | asserts the empty meta on all four surfaces and the "loads no advertising tag at all" sentences | inverted: every page carries the Microsoft meta (placeholder in static pages, `config` in the shell); `PRIVACY_TEXT` names `bat.bing.com`, `bat.bing.net`, `_uetsid`, `_uetvid`, `_uetmsclkid`, `MUID`; `PRIVACY_TEXT` does **not** contain "loads no advertising tag at all" or "Google". The "no reader of `EXPO_PUBLIC_GOOGLE_ADS_*`" case stays |
| `test/guards/privacyPolicy.test.ts` providers block | unchanged | passes once `privacy.html` names "Microsoft Advertising" and both hosts (§4.1) |
| `test/guards/analyticsCsp.test.ts` | `beacon` is a string | accept string or array; also assert `img-src` lists every beacon origin of a provider that has one — UET reports by image, and today the test only reads `connect-src` |
| `e2e/consent.spec.ts` | injects `AW-000000001`, `ADS_HOST = www.googletagmanager.com` | injects `12345678`, `ADS_HOST = bat.bing.com`; routes `bat.bing.com|bat.bing.net`; the re-prompt case writes a v1 record and expects the banner back, which is now the real migration everyone will hit |
| `e2e/support/fixtures.ts` | seeds a decision | unchanged — the version is read from `consent.js` |
| `tools/preflight/preflight.test.mjs` | "no `EXPO_PUBLIC_GOOGLE_ADS_*`" | unchanged; `public-env-passthrough` now covers the new name |
| `apps/web/e2e/welcome.spec.ts` | `?gclid=` keeps the explainer | add `?msclkid=` to the same URL — same rule, and it documents the parameter the campaign will actually send |

Break-and-watch, per `issue-workflow.md`: after extending `analyticsCsp.test.ts`, remove
`https://bat.bing.net` from `img-src` in `_headers` and confirm the test goes red; put the
"loads no advertising tag at all" sentence back into `privacy.html` and confirm the tense guard
goes red. Say which in the closing comment.

### 3.7 What to run locally, once

Per AGENTS.md's table: `e2e/consent.spec.ts --project=desktop` (the only spec that sees
`consent.js`), `jest test/lib/consent.test.ts test/guards`, `node tools/preflight/preflight.mjs`,
and `pnpm --filter @keepsake/web typecheck`. The PR run does the rest on the merged tree.

## 4. Privacy, terms and legal changes — before the tag ships, not after

The privacy page and `legal-considerations.md` both carry the sentence "this section changes
first, before a single tag loads." That sentence is the contract; the order in §6 honours it.

### 4.1 `apps/site/public/privacy.html`

- **"Advertising" paragraph, rewritten in the present tense** for a tag that does load: off
  unless you say yes; on a yes, Keepsake loads Microsoft Advertising's tag from `bat.bing.com`
  (and `bat.bing.net`), which reports to those same hosts; what it receives (page URL, referrer,
  browser details, an IP address Microsoft sees as any server does, the two events "listing went
  live" and "request sent"); what it never receives (photos, story text, email, notes, postcode
  search — anything typed); the cookies it sets on this site (`_uetsid` about a day, `_uetvid`
  about a year, `_uetmsclkid` about ninety days) and the one Microsoft sets on its own domain
  (`MUID`), which this site cannot delete; Microsoft is the recipient; used for measuring which
  advert brought you here and for nothing else — **no remarketing, no audience lists** (decision
  1). Keep the line that the id is per-build, so "if we haven't switched a tool on for a
  particular build, it doesn't load even when you've said yes".
- **Drop** "Keepsake runs no adverts and loads no advertising tag at all", "is empty in every
  version of this site that has ever been published", and the paragraph explaining why the switch
  exists with nothing behind it. Keep "this section changes first, before a single tag loads" —
  it is now a promise kept once, and worth keeping.
- **"Changing your mind"**: the promise "When you switch something off we stop sending to it
  immediately and clear the cookies it set" becomes load-bearing — `deleteCookies(['_uet'])`
  and the `ad_storage: denied` update are what make it true. Add that Microsoft's own `MUID` on
  `bing.com` is outside our reach and how to clear it (browser settings).
- **"Global Privacy Control"** stays true: GPC already forces advertising off and is checked on
  every visit. Now the sentence has a tag behind it.
- **"We don't sell or share data"**: keep. Under the CPRA, cross-context behavioural advertising
  measurement can be "sharing"; the page already says some laws count ad measurement as sharing
  and offers the "Do not sell or share" switch that forces advertising off. That switch is now
  doing real work. Do not soften the "we don't sell" sentence; Keepsake still sells nothing.
- **"Other services we rely on"**: remove the parenthetical that names Google as the tag this site
  does not load; name Microsoft Advertising as the advertising measurement provider, loaded only
  on consent.
- **"Categories of information we collect"** (the Rhode Island section, #60): add the row that
  is new — "advertising measurement identifiers (cookies set by Microsoft's tag), only if you
  consent to advertising".
- **"What changed"**: a dated entry saying the advertising group went from empty to Microsoft
  Advertising, that this is why everyone was asked again, and what the tag does and does not get.
- The `<meta>` and its comment: §3.3.

### 4.2 `apps/site/public/terms.html`

- The `<meta>` and its comment: §3.3.
- The content-licence paragraph ("Not in adverts, not on another site…") stays exactly as it is,
  and decision 6 is what keeps it true.
- Nothing else in the terms mentions advertising. No change to the disclaimer, the forum clause
  question or the prohibited-items table follows from measurement-only ads.

### 4.3 `apps/site/public/about.html`

The `<meta>` and its comment only. Checked 2026-09-10: the page's copy makes no "no ads" or
"no tracking" claim; the only mention of advertising is the comment beside the meta. The launch
audit's "no pixels, no ads" line is in `launch-audit.md`, which is a record of that date and is
not edited.

### 4.4 `docs/legal-considerations.md`

- **The Rhode Island paragraph** (the 2026-09-07 correction) says in its last lines that if ads
  are ever revisited, "this paragraph has to be rewritten before the tag ships". Rewrite it: the
  fact pattern becomes a free, no-money site that runs paid search advertising **to acquire
  visitors** and carries a consent-gated measurement tag; still no revenue. Whether RIDTPPA's
  "commercial website" reaches an advertiser with no sales is the same open applicability
  question, now leaning further toward "commercial" than the no-ads version did. The content
  disclosure itself is already met by the "Categories" section, so the practical exposure is
  unchanged; say that, and say the applicability question is still not one this pass can settle.
- **The 2026-09-07 blockquote at the top** ("Google Ads did not, and as of 2026-09-07 will not")
  gets a dated follow-on: Microsoft Advertising, measurement only, from the date the tag ships.
- **The "2026-09-08 status" bullet on the privacy page's advertising flow** (the one that says no
  tag has ever loaded on either tier) gets a dated follow-on rather than an edit, matching the
  document's own convention of leaving records in place.
- **`legal-next-actions-research.md` §6** says nothing new reaches "a zero-revenue, no-ads"
  operator and that the RIDTPPA gate "is if anything weaker… since there are now demonstrably no
  ads". Add a dated note that the second half no longer holds.

### 4.5 `docs/legal-open-questions-research.md`

- **Q2 (PIPEDA)** already concludes "assume it applies" on the strength of ads that then never
  shipped. Now they do, and the *Globe24h* analogy (a free site held commercial because it carried
  advertising) is closer than before — with the distinction that Keepsake buys adverts rather than
  carrying them. The conclusion does not change; the gaps it lists (a named accountable person,
  access and portability named as rights, retention criteria beyond photos, breach records) are
  the same, and this plan does not close them. Note the date and that the assumption is now
  fact-backed.
- **Q3 (Montana), item 2**: "the Google Ads integration is contextual" becomes "the Microsoft
  Advertising integration is measurement-only with no remarketing lists"; the constraint on any
  future targeting change stands.

### 4.6 `docs/product-decisions.md`

One new row under "Identity and privacy": *Microsoft Advertising, measurement only, consent-gated,
two conversion events, no remarketing* — when, what it costs (a third-party cookie on Microsoft's
domain for consenting visitors; a `CONSENT_VERSION` bump that re-prompts everyone once; a legal
fact pattern that leans more "commercial"), and what would change the answer (a remarketing ask,
which reopens Montana and the "no profiling" copy; or the campaign not paying for itself, which
reopens #175's decision in the other direction).

### 4.7 What is *not* a legal change

- Consent banner mechanics: opt-in default, GPC honoured, "Do not sell or share" sticky — all
  already true and already tested; the tag simply now has something to gate.
- No new data reaches Keepsake's own servers. The Worker, D1, the Observatory, the digest: none of
  them see an ad click. Attribution lives entirely in Microsoft's UI.
- The age gate, moderation, and the requester's contact flow are untouched.

## 5. Verification, on preview, before the campaign goes live

1. `verify-public-env.mjs` and `copy-site.mjs` both green on the preview deploy log — the variable
   reached the bundle and the static pages. Read the log; do not infer it from a green tick.
2. In a real browser on `preview.keepsake.ing`, fresh profile: no request to `bat.bing.*` before
   the banner is answered; on "Reject all", still none after a reload; on "Accept all", `bat.js`
   loads, the `action/0` beacon fires, and **the console shows no CSP violation** — this is the
   check `analyticsCsp.test.ts` explains cannot be done in jsdom.
3. Withdraw via "Privacy choices": `_uet*` cookies gone, no further beacons.
4. With GPC on (Brave, or Firefox's `privacy.globalprivacycontrol.enabled`): advertising is forced
   off and the note shows, tag never loads.
5. Post a listing, approve it from `/admin`, and send a request against it: the preview tag's two
   event goals show the hits in Microsoft's UI (up to a few hours' delay). Microsoft's "UET Tag
   Helper" browser extension shows events in real time and is faster.
6. Confirm `/privacy` on preview reads the new advertising section and the meta carries a real
   id, not `%EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID%`.
7. Production deploys are manual (`workflow_dispatch`); after the production deploy, repeat 1, 2
   and 6 on `keepsake.ing` — production runs behind `main` routinely and a plan that stops at
   preview has not shipped.

## 6. Order of operations

1. Kiarash: decisions in §1; Microsoft account, both UET tags, goals (§2 steps 1–5).
2. Kiarash: set `EXPO_PUBLIC_MICROSOFT_ADS_TAG_ID` in the `preview` and `production` GitHub
   Environments.
3. Agent: one PR carrying §3 and §4 together, with the tests in §3.6 and the break-and-watch
   evidence in the closing comment. Docs and code in one PR on purpose: the guards make the legal
   copy and the code fail together, and splitting them would ship one without the other.
4. Merge; the preview deploy runs; §5 steps 1–6.
5. Manual production deploy; §5 step 7.
6. Kiarash: campaign live (§2 steps 6–7). Watch spend against the Observatory's give→get funnel
   for a week; the campaign's only success metric is listings and requests, not clicks.

## 7. What this plan does not do

- It does not restore anything Google. `EXPO_PUBLIC_GOOGLE_ADS_*` stays banned by preflight.
- It does not add remarketing, audience lists, enhanced conversions, or offline conversion
  uploads. Each of those hands Microsoft more than a page URL and two event names, and each would
  reopen §4.
- It does not touch the API. There is no server-side conversion API call, no click-id storage in
  D1, and nothing for `redact.ts` to learn.
- It does not settle the Rhode Island applicability question or PIPEDA's accountability gaps.
  Both were open before ads and stay open after; it only records that the fact pattern moved.
