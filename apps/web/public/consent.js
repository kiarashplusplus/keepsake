// Keepsake consent store + banner — the ONE implementation.
//
// WHY ONE FILE
//
// Ported from finderly-monorepo, where consent lived in localStorage and the
// key, the version and the parse rules were hand-copied into five places
// (cookie-banner.js, two copies of gtm-init.js, analytics-init.js, and a
// Svelte widget in another repo). Two failures came out of that:
//
//   1. localStorage is origin-scoped, and www/app were different origins, so a
//      visitor who accepted on the marketing site was prompted again in the
//      app. Finderly fixed that with a `fx_consent` cookie on the parent
//      domain plus a shared `window.__fxConsent` module.
//   2. The markup was duplicated too (CookieBanner.astro / CookieBanner.svelte)
//      and silently drifted: six design tokens that only existed in one repo
//      resolved to nothing in the other, so one surface asked for consent in a
//      different typeface from its neighbour.
//
// Keepsake has ONE origin: `apps/site`'s static HTML (/about, /privacy,
// /terms) and the Expo-web app are served by the same Worker from the same
// `dist/`. So the cookie-mirroring half of Finderly's fix is DELIBERATELY NOT
// PORTED — there is no subdomain boundary to carry a decision across, and a
// second copy of the state (cookie + localStorage) is a second thing to drift.
// The single-implementation half IS ported, and this is it: one codec, one
// banner template, one set of loaders, loaded as `<script src="/consent.js">`
// by both the static pages and `apps/web/app/+html.tsx`.
//
// `apps/web/src/lib/consent.ts` is the app's typed view of this file. It
// DELEGATES; it does not reimplement the codec. A second implementation is a
// second thing to keep in step with CONSENT_VERSION, and that drift does not
// throw — it silently re-prompts whichever surface holds the higher number.
//
// LOADING
//
// Deferred is fine, and it is what both surfaces do. Nothing non-essential is
// loaded by anything except this file, so there is no third-party tag racing
// us to run before the decision is read — which is the reason Finderly had to
// load its store blocking, ahead of gtm-init.js.
(function () {
  'use strict';

  // Re-entry guard. Also the "already booted" signal `consent.ts` checks.
  if (window.__ksConsent) return;

  // ── Storage ───────────────────────────────────────────────────────────────

  // The `.v1` suffix is the STORAGE FORMAT version (matching the repo's
  // `keepsake.theme.v1` / `keepsake.ownerToken.v1` convention), NOT the
  // consent version. They are separate on purpose: changing how the record is
  // encoded must not be confused with changing what the user agreed to.
  // Finderly learned this the expensive way — its cookie carried a
  // COOKIE_ENCODING_VERSION distinct from CONSENT_VERSION for exactly this
  // reason.
  const STORAGE_KEY = 'keepsake.consent.v1';

  /**
   * Current consent schema version. Bumping this invalidates every stored
   * decision and re-prompts every visitor — the one-time re-consent gesture
   * for a material change in processing purposes.
   *
   * v1 = strictly necessary / analytics / advertising, as described on
   *      /privacy. Default is refusal for both optional categories.
   *
   * Bump it when a CATEGORY is added, removed, or changes meaning. Do not
   * bump it to add an optional field to the record — an absent field on an
   * older record reads as `undefined`, which is already the right answer for
   * a visitor who never made that choice (this is why `saleOptOut` was added
   * without a bump).
   *
   * Unlike Finderly, a bump here is cheap and safe: web is the only platform,
   * every surface has the banner, and there is no native install with no
   * re-prompt surface to strand. `e2e/consent.spec.ts` proves the re-prompt
   * actually happens by writing a v0 record and asserting the banner returns.
   */
  const CONSENT_VERSION = 1;

  /**
   * The third-party loaders this file owns, and the ONLY ones. Every entry is
   * gated on its category; nothing here is fetched before a decision.
   *
   * `apps/web/test/guards/privacyPolicy.test.ts` parses this array and fails
   * if a provider's name or host is not disclosed in
   * `apps/site/public/privacy.html`, and if any other third-party host appears
   * in this file. That guard is what stops the code and the published policy
   * from drifting — the exact failure `docs/runbooks/launch-audit.md` §7 found
   * (the policy claimed Cloudflare Web Analytics was running; nothing loaded
   * it).
   *
   * `meta` is the name of the <meta> tag carrying the id/token. It comes from
   * an `EXPO_PUBLIC_*` variable at build time (`apps/web/app/+html.tsx` for the
   * app, `apps/web/scripts/copy-site.mjs` for the static pages). An absent or
   * malformed meta is the kill switch: nothing loads, in any environment,
   * whatever the visitor consented to.
   */
  const PROVIDERS = [
    {
      category: 'analytics',
      name: 'Cloudflare Web Analytics',
      host: 'static.cloudflareinsights.com',
      meta: 'ks-cf-beacon-token',
      // Where the tag *reports*, which is a different origin from where it is
      // *fetched* — note the missing `static.`. `script-src` covers the fetch
      // and `connect-src` covers this, and having one without the other loads
      // a beacon that is then blocked from saying anything. Named here so
      // `apps/web/test/guards/analyticsCsp.test.ts` can hold both CSP copies
      // to it; see that file for how this was found in production.
      beacon: 'https://cloudflareinsights.com'
    },
    {
      category: 'advertising',
      name: 'Google Ads',
      host: 'www.googletagmanager.com',
      meta: 'ks-google-ads-id'
    }
  ];

  // ── Small helpers ─────────────────────────────────────────────────────────

  function meta(name) {
    let el = document.querySelector('meta[name="' + name + '"]');
    let value = el ? (el.getAttribute('content') || '').trim() : '';
    // `copy-site.mjs` leaves the literal placeholder in place when the
    // variable is unset, and the site's standalone preview server never
    // substitutes at all. Treat both as "not configured".
    if (!value || value.charAt(0) === '%') return '';
    return value;
  }

  function readRaw() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null; // Safari private mode, storage disabled, etc.
    }
  }

  function writeRaw(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Global Privacy Control.
   *
   * Set by Brave, Firefox, DuckDuckGo and several extensions, and a legally
   * binding opt-out signal under California, Colorado, Connecticut, Texas,
   * Oregon, Montana, New Jersey, Delaware and others. Honoured universally
   * rather than gated on the visitor's state: cheaper than a state-by-state
   * branch, and never the wrong answer.
   */
  function gpc() {
    try {
      return navigator.globalPrivacyControl === true;
    } catch {
      return false;
    }
  }

  // ── Codec ─────────────────────────────────────────────────────────────────

  /**
   * Parse a stored record. Returns null for "no current decision on file",
   * which is what makes the banner show.
   *
   * A version that is not exactly CONSENT_VERSION reads as no decision —
   * `!==`, not `<`, so a record written by a newer build that someone then
   * rolled back also re-prompts rather than being half-trusted.
   */
  function parse(raw) {
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== CONSENT_VERSION) return null;
    return {
      strictlyNecessary: true,
      analytics: parsed.analytics === true,
      advertising: parsed.advertising === true,
      saleOptOut: parsed.saleOptOut === true,
      gpcObserved: parsed.gpcObserved === true,
      version: CONSENT_VERSION,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString()
    };
  }

  /**
   * The record as WRITTEN, GPC not applied. Internal, plus one public use:
   * the banner's own checkboxes, which need to show the visitor what they
   * chose alongside what the browser signal overrides.
   *
   * Nothing that gates a load may call this. See `read()`.
   */
  function readStored() {
    return parse(readRaw());
  }

  /**
   * The decision as it is ENFORCED — the stored record with a Global Privacy
   * Control signal laid over the top.
   *
   * This is the public `read()`, and `readStored()` is the awkward one to
   * reach, on purpose. The obvious call has to be the safe one: a stored
   * `advertising: true` from before the visitor turned GPC on must never
   * out-rank the signal they are sending right now, and a caller who reaches
   * for the plainly-named function must not be able to get that wrong.
   *
   * Returns null when there is no decision at all, so "not asked yet" and
   * "asked, and said no" stay distinguishable — the banner needs the
   * difference; the loaders do not.
   */
  function read() {
    let stored = readStored();
    if (!stored) return null;
    if (!gpc()) return stored;
    return {
      strictlyNecessary: true,
      analytics: stored.analytics,
      advertising: false,
      saleOptOut: true,
      gpcObserved: true,
      version: stored.version,
      timestamp: stored.timestamp
    };
  }

  /**
   * Persist a decision.
   *
   * `saleOptOut` is STICKY, unlike every other field: this function rebuilds
   * the record from `partial`, so an omitted key means false everywhere else,
   * and for a statutory Do-Not-Sell request that would be a bug with legal
   * consequences — flipping the Analytics box later would silently erase a
   * request the visitor made deliberately. Only an explicit
   * `saleOptOut: false` clears it. Ported verbatim in spirit from Finderly's
   * `setConsentChoices`, which learned it from migration 041's rule that
   * nothing implicitly writes an 'opt_in'.
   */
  function write(partial) {
    let previous = readStored();
    let advertising = partial.advertising === true;
    let saleOptOut =
      partial.saleOptOut === false
        ? false
        : partial.saleOptOut === true || (previous ? previous.saleOptOut === true : false);
    // Refusing to be sold/shared and allowing advertising measurement are not
    // compatible positions. The opt-out wins.
    if (saleOptOut || gpc()) advertising = false;

    let record = {
      strictlyNecessary: true,
      analytics: partial.analytics === true,
      advertising: advertising,
      saleOptOut: saleOptOut || gpc(),
      gpcObserved: gpc(),
      version: CONSENT_VERSION,
      timestamp: new Date().toISOString()
    };
    writeRaw(JSON.stringify(record));
    apply();
    emit();
    // A decision exists now, so the banner has nothing left to ask. Closing
    // here rather than only in the click handlers means every path that
    // records a decision — including `window.__ksConsent.write()` called from
    // the app — leaves the same state behind.
    close();
    return record;
  }

  function isAllowed(category) {
    // Answered before the decision is even read: "strictly necessary" is not a
    // choice the visitor makes, so it cannot be pending. Reading first would
    // return false for it before anyone has answered the banner — which is
    // how a gate ends up switching off the thing that renders the gate.
    if (category === 'strictlyNecessary') return true;
    let current = read();
    if (!current) return false;
    return current[category] === true;
  }

  // ── Subscribers ───────────────────────────────────────────────────────────

  const listeners = [];

  function emit() {
    let current = read();
    for (let i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](current);
      } catch {
        /* never let a stray listener break the consent flow */
      }
    }
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      let index = listeners.indexOf(fn);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  // ── Loaders ───────────────────────────────────────────────────────────────
  //
  // Injection is one-way inside a document: a <script> already evaluated
  // cannot be un-evaluated. So withdrawal does three things instead —
  // tells Google Consent Mode to deny, deletes the cookies those tags set,
  // and refuses to inject again. The tag that is already in memory is gone on
  // the next page load. /privacy says exactly that; do not quietly change one
  // without the other.

  const loaded = {};

  function injectScript(src, attributes) {
    let script = document.createElement('script');
    script.async = true;
    script.src = src;
    if (attributes) {
      for (let key in attributes) {
        if (Object.prototype.hasOwnProperty.call(attributes, key)) script.setAttribute(key, attributes[key]);
      }
    }
    document.head.appendChild(script);
  }

  function deleteCookies(prefixes) {
    let all = String(document.cookie || '').split(';');
    for (let i = 0; i < all.length; i += 1) {
      let name = all[i].split('=')[0].trim();
      if (!name) continue;
      for (let p = 0; p < prefixes.length; p += 1) {
        if (name.indexOf(prefixes[p]) !== 0) continue;
        let expiry = '=; Max-Age=0; path=/';
        document.cookie = name + expiry;
        document.cookie = name + expiry + '; domain=' + location.hostname;
        document.cookie = name + expiry + '; domain=.' + location.hostname;
      }
    }
  }

  function gtagShim() {
    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      window.gtag = function () {
        // Must push `arguments` itself, not an array copy — Google's tag reads
        // the arguments object's shape, and anything else is silently ignored.
        window.dataLayer.push(arguments);
      };
    }
    return window.gtag;
  }

  function applyAdvertising(granted) {
    let id = meta('ks-google-ads-id');
    if (!/^(AW|G|GT)-[A-Z0-9_-]+$/i.test(id)) return; // kill switch: not configured

    if (!granted) {
      if (loaded.advertising) {
        gtagShim()('consent', 'update', {
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied'
        });
        deleteCookies(['_gcl', '_gac', '_ga']);
      }
      return;
    }
    if (loaded.advertising) return;
    loaded.advertising = true;

    let gtag = gtagShim();
    // Consent Mode v2 defaults, denied, set BEFORE the tag loads even though
    // we only load it on a grant. Belt and braces: if the tag is ever loaded
    // by something other than this function, it still starts denied.
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied'
    });
    gtag('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted'
    });
    gtag('js', new Date());
    gtag('config', id);
    injectScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id));
  }

  function applyAnalytics(granted) {
    let token = meta('ks-cf-beacon-token');
    if (!token) return; // kill switch: not configured

    if (!granted) {
      // Cloudflare Web Analytics is cookieless, so there is nothing to clear;
      // it simply never gets injected, and stops on the next load if it was.
      return;
    }
    if (loaded.analytics) return;
    loaded.analytics = true;
    injectScript('https://static.cloudflareinsights.com/beacon.min.js', {
      'data-cf-beacon': JSON.stringify({ token: token })
    });
  }

  /** Reconcile every loader against the current effective decision. */
  function apply() {
    applyAnalytics(isAllowed('analytics'));
    applyAdvertising(isAllowed('advertising'));
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  //
  // The markup and the stylesheet both live here, so a surface opts in with a
  // <script> tag and nothing else — no ids to keep in sync, no tokens to
  // re-declare, no template to port into the React tree. That is the direct
  // lesson from Finderly's two hand-synced banner templates.
  //
  // Colours are the v3 "Polaroids on a table" tokens
  // (`packages/tokens/src/colors.ts`), hard-coded rather than read from CSS
  // variables: `apps/site/public/site.css` flips `--surface` per theme while
  // the app keeps it constant, so a var() would render two different banners.
  // The bar is cut from the constant cream index card (`surface #F1E6CC`)
  // with constant ink in BOTH themes, which is the identity's own rule — a
  // printed card does not change colour when the lights go down — and it
  // means every contrast pair below is verified once and holds in light and
  // dark:
  //   ink #1B1815 on #F1E6CC               14.3:1  title, body, disclosure
  //   pencil #5A524A on #F1E6CC             6.2:1  category blurbs, footnote
  //   stampText #8A2113 on #F1E6CC          7.3:1  eyebrow, GPC note, links
  //   onAccent2 #F1E6CC on accent2 #1B1815  14.3:1  EVERY button's label
  //   accent2 #1B1815 on #F1E6CC           14.3:1  ...and that button's fill
  //                                                 against the bar behind it
  //   focus #7A2515 on #F1E6CC              8.1:1  the focus ring
  //
  // Those numbers were RECOMPUTED for #223 with
  // `packages/tokens/src/contrast.ts`'s `contrastRatio()`, because #223
  // changed which pairs exist here. The line this block used to carry —
  // `onAccent #FBF9F4 on #C4341C  5.2:1 (the stamp button)` — left with the
  // button that wore it (see the button comment below). Stamp red `#C4341C`
  // survives in this file only where it is decorative and carries no text:
  // the GPC note's left rule, and the checkboxes' native `accent-color`.
  // The bottom bar's gradient scrim is decorative too — no text sits on it,
  // so it has no pair to verify.
  //
  // `e2e/a11y.spec.ts`'s "consent banner" block re-checks them with axe on a
  // real page, in light and dark, closed and with the panel open. That block
  // was added by #173; before it, this comment named a scan that did not
  // exist — every a11y context seeded a consent decision, so the banner was
  // never in the DOM during a scan. The numbers were right the whole time;
  // nothing was checking they stayed right.

  const STYLE = [
    // ── Docked to the bottom edge, not floating (#223) ────────────────────
    //
    // This was a floating 560px box with a drop shadow, centred over the page
    // with nothing behind it — and on the desktop feed it landed on top of
    // the category chips (`docs/qa/baseline/ux-desktop/consent-banner.jpg`
    // shows it covering the middle of the filter row). It read as an element
    // that had failed to position rather than as a deliberate interruption.
    //
    // So: a full-bleed bar docked to the bottom edge. `.ks-consent` IS the
    // bar now — the cream index card, a 2px ink rule along its top edge and
    // nothing on the other three, because those three edges are the
    // viewport's — and `.ks-consent__card` is demoted to an inner column
    // doing one job, holding the copy to a readable measure so it does not
    // run 1900px wide on a desktop. It keeps the name `__card` on purpose:
    // renaming it would mean touching `apps/site/public/*.html` and the
    // specs, and #223 is styling and layout only.
    //
    // NOT a modal scrim, and that is the deliberate part. A scrim that blocks
    // the page until the visitor answers turns a banner into a consent wall,
    // and a visitor who cannot read the site without answering is not freely
    // giving consent — a WORSE legal posture than the unequal prominence this
    // issue set out to fix. What it gets instead is `.ks-consent::before`: a
    // short gradient sitting directly above the bar with
    // `pointer-events:none`. It separates the bar from whatever is scrolling
    // behind it and does nothing else — blocks nothing, catches no clicks,
    // carries no text (hence no contrast pair for it in the block above).
    //
    // `pointer-events` on the bar itself is gone in both places. The old
    // outer div was a transparent full-width flex container whose padding
    // would otherwise have swallowed clicks in it, hence `none` there and
    // `auto` on the card; the bar is opaque and IS the banner, so the default
    // is right. `e2e/consent.spec.ts`'s "does not cover the primary action on
    // a 390px viewport" is the guard on that — it trial-clicks the hero CTA
    // with the banner up, so a bar that grew tall enough to sit over it
    // fails rather than merely looking wrong.
    //
    // `max-height`/`overflow-y` stay on the inner column so the expanded
    // panel still scrolls inside a small screen rather than pushing the bar
    // off the top of it. 82vh dropped to 78vh only because the bar's own
    // padding and rule now sit outside that box and still have to fit.
    '.ks-consent{position:fixed;left:0;right:0;bottom:0;z-index:9999;box-sizing:border-box;',
    'padding:14px 16px;background:#F1E6CC;color:#1B1815;border-top:2px solid #1B1815;',
    'font-family:"CourierPrime","Courier Prime",ui-monospace,monospace;}',
    '.ks-consent[hidden]{display:none!important;}',
    '.ks-consent::before{content:"";position:absolute;left:0;right:0;bottom:100%;height:48px;',
    'pointer-events:none;background:linear-gradient(to top,rgba(27,24,21,.18),rgba(27,24,21,0));}',
    '.ks-consent__card{box-sizing:border-box;width:100%;max-width:560px;margin:0 auto;',
    'max-height:78vh;overflow-y:auto;}',
    '.ks-consent__eyebrow{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#8A2113;}',
    '.ks-consent__title{margin:0 0 6px;font-size:15px;font-weight:700;line-height:1.35;color:#1B1815;}',
    '.ks-consent__body{margin:0 0 10px;font-size:13px;line-height:1.55;color:#1B1815;}',
    '.ks-consent__note{margin:0 0 10px;font-size:12px;line-height:1.5;color:#8A2113;border-left:2px solid #C4341C;padding-left:8px;}',
    '.ks-consent__note[hidden]{display:none!important;}',
    '.ks-consent__actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px;}',
    // ── One button style, and neither answer is the recommended one ───────
    //
    // Resolves #223's first half, and part of #224's "a third button style
    // with unclear rank" as a side effect — see the last paragraph.
    //
    // Equal prominence is not decorative: a reject that is smaller, paler, or
    // one click further away than accept is the specific pattern regulators
    // fine people for. The geometry half of that was always right here — same
    // element, same font, same padding, same min-height, side by side, one
    // click each, Reject FIRST in DOM and reading order, and
    // `e2e/consent.spec.ts`'s "reject is exactly as easy as accept" measures
    // the two boxes so it stays right.
    //
    // The COLOUR half was not (#223). `Accept all` wore `--stamp` (filled
    // `accent #C4341C`) and `Reject all` wore `--outline` (a near-white
    // `print #FBF9F4` fill inside an ink border). Stamp red is what every
    // primary action in this product wears, so the whole system was quietly
    // teaching that accept is the button you are meant to press — and both
    // the EDPB's guidance on valid consent and the CPRA's dark-pattern
    // provisions (the CCPA regulations' "symmetry in choice") treat unequal
    // prominence between accept and reject as a defect in the consent
    // MECHANISM rather than a matter of taste. This repo already carries
    // deliberate CCPA work, so it was worth a decision rather than an
    // accident.
    //
    // Both now wear `accent2 #1B1815` filled with an `onAccent2 #F1E6CC`
    // label: the pair `apps/web/src/ui/Button.tsx`'s `secondary` case adopted
    // for #134, and the long comment there is the argument. A filled ink
    // rectangle is unmistakably a control — 14.3:1 against the paper it sits
    // on, where `--outline`'s `print` fill measured 1.18:1 against the same
    // paper and read as an empty field with a line round it — while staying
    // clearly subordinate to the one stamp-red primary elsewhere in the
    // product. Applying it to BOTH does two things at once: it removes the
    // unequal prominence, and it takes stamp red off a screen where neither
    // answer is the one we are recommending.
    //
    // `Save choices`, in the expanded panel, deliberately gets the IDENTICAL
    // treatment rather than a third one. It is not a rival to accept/reject:
    // it is the only action in its own row, reached only by opening the
    // panel, so matching it costs no hierarchy — and styling it more weakly
    // would re-introduce the exact asymmetry above against the visitor who
    // took the trouble to choose per category. That leaves `.ks-consent__btn`
    // as the file's only button rule (`--outline` and `--stamp` are gone),
    // which is the part of #224 this closes. `.ks-consent__more` stays a
    // plain underlined line because it is a DISCLOSURE, not an answer — it
    // records no decision and its `aria-expanded` says so.
    '.ks-consent__btn{flex:1 1 0;min-width:132px;min-height:44px;box-sizing:border-box;padding:10px 14px;',
    'font:inherit;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;',
    'background:#1B1815;color:#F1E6CC;border:2px solid #1B1815;border-radius:2px;cursor:pointer;',
    // The same pressed-stamp lift `Button.tsx`'s `secondary` carries, to the
    // same two alpha values, so the banner and the app agree on what a
    // filled-ink control looks like when you hover it.
    'box-shadow:2px 3px 0 rgba(27,24,21,.22);}',
    '.ks-consent__btn:hover{box-shadow:3px 5px 0 rgba(27,24,21,.28);}',
    '.ks-consent__more{display:block;min-height:44px;background:none;border:0;padding:0;cursor:pointer;',
    'font:inherit;font-size:12px;letter-spacing:.5px;color:#1B1815;text-decoration:underline;text-underline-offset:3px;}',
    '.ks-consent__panel{margin:8px 0 0;border-top:1px solid rgba(27,24,21,.32);padding-top:10px;}',
    '.ks-consent__panel[hidden]{display:none!important;}',
    '.ks-consent__row{display:flex;gap:10px;align-items:flex-start;padding:8px 0;}',
    '.ks-consent__row input{margin:2px 0 0;width:18px;height:18px;flex:0 0 auto;accent-color:#C4341C;}',
    '.ks-consent__row label{font-size:13px;font-weight:700;line-height:1.4;color:#1B1815;cursor:pointer;}',
    '.ks-consent__row label span{display:block;font-weight:400;font-size:12px;line-height:1.5;color:#5A524A;}',
    '.ks-consent__foot{margin:10px 0 0;font-size:12px;line-height:1.5;color:#5A524A;}',
    '.ks-consent__foot a{color:#8A2113;}',
    '.ks-consent :focus-visible{outline:2px solid #7A2515;outline-offset:3px;}',
    // The reopen control, wherever a surface puts one. Styled here rather than
    // in `apps/site/public/site.css` so a static page opts in with the bare
    // attribute and inherits its own footer's colour and size — one rule, no
    // second stylesheet to keep in step, and nothing for the app (which has no
    // site.css at all) to duplicate.
    '[data-ks-consent]{background:none;border:0;margin:0;padding:0;font:inherit;color:inherit;',
    'cursor:pointer;text-decoration:underline;text-underline-offset:3px;}',
    '@media (min-width:560px){.ks-consent{padding:18px 24px;}}',
    // The one animation. #223 moved it from the inner column to the bar and
    // changed the distance: a docked bar rises from the edge it is docked to,
    // so this slides the whole bar up from below the viewport
    // (`translateY(100%)`) instead of drifting the old floating box 12px. The
    // gradient scrim is a pseudo-element of the bar, so it comes up with it
    // rather than appearing first over an empty edge.
    //
    // It still collapses to nothing under reduce-motion — `e2e/a11y.spec.ts`
    // runs with `reducedMotion: "reduce"`, and axe reads computed colour at
    // one instant, so a mid-fade opacity would invent contrast failures.
    '@media (prefers-reduced-motion:no-preference){',
    '.ks-consent{animation:ks-consent-in 240ms cubic-bezier(.22,1,.36,1) both;}',
    '@keyframes ks-consent-in{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}}'
  ].join('');

  const COPY =
    'Keepsake needs a couple of things to work at all — nothing you can turn off, and nothing that follows you elsewhere. ' +
    'Everything beyond that is off unless you say yes.';

  const GPC_NOTE =
    'Your browser is sending a Global Privacy Control signal. We are treating that as a refusal of advertising ' +
    'and as a "do not sell or share my personal information" request, so that choice is made for you and locked below.';

  let root = null;
  const el = {};

  function element(tag, attributes, children) {
    let node = document.createElement(tag);
    for (let key in attributes) {
      if (!Object.prototype.hasOwnProperty.call(attributes, key)) continue;
      if (attributes[key] === true) node.setAttribute(key, '');
      else if (attributes[key] !== false && attributes[key] != null) node.setAttribute(key, attributes[key]);
    }
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function categoryRow(id, name, disabled, description) {
    let input = element('input', { type: 'checkbox', id: id });
    if (disabled) input.disabled = true;
    return {
      input: input,
      node: element('div', { class: 'ks-consent__row' }, [
        input,
        element('label', { for: id }, [name, element('span', {}, [description])])
      ])
    };
  }

  function build() {
    if (root) return;

    let style = document.createElement('style');
    // NOT `data-ks-consent` — that attribute means "reopen control" (see the
    // CSS rule and the click-delegation below), and a <style> tag carrying it
    // too was a real bug: `document.querySelectorAll('[data-ks-consent]')`
    // resolved to the stylesheet AND the footer button, which is exactly the
    // kind of thing a strict-mode Playwright locator (and any future caller
    // of that selector) is right to refuse rather than silently pick one.
    style.id = 'ks-consent-style';
    style.appendChild(document.createTextNode(STYLE));
    document.head.appendChild(style);

    let necessary = categoryRow(
      'ks-consent-necessary',
      'Strictly necessary',
      true,
      'Your device key, your theme, and this choice itself. Always on — it is what makes the site work, not a preference.'
    );
    necessary.input.checked = true;

    let analytics = categoryRow(
      'ks-consent-analytics',
      'Analytics',
      false,
      'Cloudflare Web Analytics — cookieless page counts, no cross-site tracking.'
    );
    let advertising = categoryRow(
      'ks-consent-advertising',
      'Advertising',
      false,
      'Google Ads measurement, so we can tell which advert brought you here.'
    );
    let sale = categoryRow(
      'ks-consent-sale',
      'Do not sell or share my personal information',
      false,
      'The CCPA/CPRA request. Turning this on also switches advertising off and keeps it off.'
    );

    el.note = element('p', { class: 'ks-consent__note', id: 'ks-consent-gpc', hidden: true }, [GPC_NOTE]);
    // #223: both answers carry the SAME class and therefore the same fill,
    // border, shadow and type — the only difference between them is the word
    // on the label. They differed by class (`--stamp` / `--outline`) until
    // then; see the `.ks-consent__btn` comment for why that was a defect in
    // the consent mechanism and not a styling preference. Ids, order and
    // handlers are untouched.
    el.reject = element('button', { type: 'button', id: 'ks-consent-reject', class: 'ks-consent__btn' }, ['Reject all']);
    el.accept = element('button', { type: 'button', id: 'ks-consent-accept', class: 'ks-consent__btn' }, ['Accept all']);
    el.more = element('button', { type: 'button', id: 'ks-consent-customise', class: 'ks-consent__more', 'aria-expanded': 'false', 'aria-controls': 'ks-consent-panel' }, ['Choose what to allow']);
    // Same class as the two above, deliberately (#223/#224 — see the
    // `.ks-consent__btn` comment). `flex:0 0 auto` is the one thing that
    // differs and it is width, not weight: Save is alone in its row, so
    // stretching it edge to edge would make the panel's confirm look like a
    // bigger decision than the two answers above it.
    el.save = element('button', { type: 'button', id: 'ks-consent-save', class: 'ks-consent__btn', style: 'flex:0 0 auto' }, ['Save choices']);
    el.analytics = analytics.input;
    el.advertising = advertising.input;
    el.sale = sale.input;

    el.panel = element('div', { class: 'ks-consent__panel', id: 'ks-consent-panel', hidden: true }, [
      necessary.node,
      analytics.node,
      advertising.node,
      sale.node,
      element('div', { class: 'ks-consent__actions' }, [el.save])
    ]);

    root = element('div', { class: 'ks-consent', id: 'ks-consent', role: 'region', 'aria-label': 'Privacy choices', hidden: true }, [
      element('div', { class: 'ks-consent__card' }, [
        element('p', { class: 'ks-consent__eyebrow' }, ['Privacy']),
        element('p', { class: 'ks-consent__title' }, ['Your choice, before anything loads.']),
        element('p', { class: 'ks-consent__body' }, [COPY]),
        el.note,
        element('div', { class: 'ks-consent__actions' }, [el.reject, el.accept]),
        el.more,
        el.panel,
        element('p', { class: 'ks-consent__foot' }, [
          'You can change this any time. ',
          element('a', { href: '/privacy' }, ['What each one does'])
        ])
      ])
    ]);

    el.reject.addEventListener('click', function () {
      write({ analytics: false, advertising: false, saleOptOut: true });
      close();
    });
    el.accept.addEventListener('click', function () {
      // Under GPC this grants analytics only — `write()` forces advertising
      // off — and the label says so, so the button never claims more than it
      // does.
      write({ analytics: true, advertising: true });
      close();
    });
    el.more.addEventListener('click', function () {
      let open = el.panel.hasAttribute('hidden');
      if (open) el.panel.removeAttribute('hidden');
      else el.panel.setAttribute('hidden', '');
      el.more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    el.sale.addEventListener('change', function () {
      if (el.sale.checked) {
        el.advertising.checked = false;
        el.advertising.disabled = true;
      } else if (!gpc()) {
        el.advertising.disabled = false;
      }
    });
    el.save.addEventListener('click', function () {
      write({
        analytics: el.analytics.checked,
        advertising: el.advertising.checked,
        saleOptOut: el.sale.checked
      });
      close();
    });

    document.body.appendChild(root);
  }

  function syncControls() {
    let stored = readStored();
    let underGpc = gpc();
    el.analytics.checked = stored ? stored.analytics : false;
    el.advertising.checked = stored ? stored.advertising && !underGpc : false;
    el.sale.checked = underGpc || (stored ? stored.saleOptOut : false);
    el.advertising.disabled = underGpc || el.sale.checked;
    if (underGpc) {
      el.note.removeAttribute('hidden');
      el.accept.textContent = 'Accept analytics';
      el.sale.disabled = true;
    } else {
      el.note.setAttribute('hidden', '');
      el.accept.textContent = 'Accept all';
      el.sale.disabled = false;
    }
  }

  /**
   * Show the banner. `expanded` opens the per-category panel — that is what
   * the "Privacy choices" footer link does, because a visitor who clicked a
   * link promising choices should land on the choices, not on a two-button
   * bar they have already answered once.
   */
  function open(expanded) {
    build();
    syncControls();
    if (expanded) {
      el.panel.removeAttribute('hidden');
      el.more.setAttribute('aria-expanded', 'true');
    }
    root.removeAttribute('hidden');
  }

  function close() {
    if (root) root.setAttribute('hidden', '');
  }

  function boot() {
    apply();
    // Built unconditionally, even when there is nothing to ask: `build()` is
    // what injects the stylesheet, and a `[data-ks-consent]` reopen control in
    // a page footer must be styled from first paint, not from the first time
    // somebody clicks it.
    build();
    if (!read()) open(false);
    // Delegated so any surface — a static <button data-ks-consent> in a
    // footer, or a React <Pressable> that renders long after this script ran —
    // reopens the same banner with no registration step.
    document.addEventListener('click', function (event) {
      let target = event.target;
      while (target && target !== document.body) {
        if (target.hasAttribute && target.hasAttribute('data-ks-consent')) {
          event.preventDefault();
          open(true);
          return;
        }
        target = target.parentNode;
      }
    });
  }

  window.__ksConsent = {
    version: CONSENT_VERSION,
    storageKey: STORAGE_KEY,
    providers: PROVIDERS,
    read: read,
    readStored: readStored,
    write: write,
    isAllowed: isAllowed,
    gpc: gpc,
    subscribe: subscribe,
    open: open,
    close: close
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
