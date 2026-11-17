/**
 * English Wikipedia: does a title exist, what does it redirect to, what is
 * its plain text at the current revision, and what does search turn up.
 */

export const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
export const LICENSE = {
  name: "CC BY-SA 4.0",
  url: "https://creativecommons.org/licenses/by-sa/4.0/",
};

const api = (params) =>
  `${WIKIPEDIA_API}?${new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params })}`;

export const articleUrl = (title) =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
export const revisionUrl = (revid) => `https://en.wikipedia.org/w/index.php?oldid=${revid}`;
export const historyUrl = (title) =>
  `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title.replace(/ /g, "_"))}&action=history`;

/**
 * Resolve up to 50 titles per request to the page each lands on (after
 * normalisation and redirects) **and its current revision**. Missing and
 * disambiguation pages are left out of the result.
 *
 * Deliberately uncached: this is the cheap call that tells `fetchArticle`
 * whether its cached text is still the current revision, so a re-run of a
 * thousand cities costs one request per 50 articles plus one per article
 * that was actually edited.
 */
export async function lookupPages(client, titles) {
  const found = new Map();
  const unique = [...new Set(titles.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const body = await client.getJson(
      api({
        action: "query",
        redirects: "1",
        prop: "revisions|pageprops",
        rvprop: "ids|timestamp",
        ppprop: "disambiguation|wikibase_item",
        titles: batch.join("|"),
      }),
      { cache: false },
    );
    const q = body.query ?? {};
    const follow = new Map();
    for (const n of q.normalized ?? []) follow.set(n.from, n.to);
    for (const r of q.redirects ?? []) follow.set(r.from, r.to);
    const pages = new Map((q.pages ?? []).map((p) => [p.title, p]));
    for (const requested of batch) {
      let title = requested;
      for (let hops = 0; follow.has(title) && hops < 5; hops++) title = follow.get(title);
      const page = pages.get(title);
      if (!page || page.missing || page.invalid || page.pageprops?.disambiguation !== undefined)
        continue;
      found.set(requested, {
        title: page.title,
        pageId: page.pageid,
        revisionId: page.revisions?.[0]?.revid ?? null,
        revisionTimestamp: page.revisions?.[0]?.timestamp ?? null,
        wikidataId: page.pageprops?.wikibase_item ?? null,
      });
    }
  }
  return found;
}

const extractKey = (pageId, revisionId) => `enwiki:extract:${pageId}:${revisionId}`;

/**
 * Plain text of a page at its current revision. `page` comes from
 * `lookupPages`. When the cache already holds that revision's text, no
 * request is made. TextExtracts can only return one full article per
 * request, which makes this the expensive call that the revision check
 * exists to avoid.
 */
export async function fetchArticle(client, page) {
  const wanted = extractKey(page.pageId, page.revisionId);
  const cached = page.revisionId ? client.peek(wanted) : undefined;
  if (cached) return cached;

  const body = await client.getJson(
    api({
      action: "query",
      prop: "extracts|revisions|pageprops",
      explaintext: "1",
      exsectionformat: "wiki",
      rvprop: "ids|timestamp",
      ppprop: "wikibase_item|disambiguation",
      pageids: String(page.pageId),
    }),
    { cache: false },
  );
  const p = body.query?.pages?.[0];
  if (!p || p.missing || p.pageprops?.disambiguation !== undefined || !p.extract) return null;
  const revision = p.revisions?.[0] ?? {};
  const article = {
    title: p.title,
    pageId: p.pageid,
    revisionId: revision.revid ?? null,
    revisionTimestamp: revision.timestamp ?? null,
    wikidataId: p.pageprops?.wikibase_item ?? null,
    text: p.extract,
  };
  // Filed under the revision actually returned: if the page was edited
  // between lookup and fetch, the text and its revision id still agree.
  if (article.revisionId) client.remember(extractKey(article.pageId, article.revisionId), article);
  return article;
}

const SEARCH_SKIP =
  /^(?:List of|Lists of|Index of|Outline of|Timeline of|Glossary of)\b|\(disambiguation\)$/;

/** Full-text search in the article namespace; list/index pages dropped. */
export async function search(client, query, limit) {
  const body = await client.getJson(
    api({
      action: "query",
      list: "search",
      srsearch: query,
      srnamespace: "0",
      srlimit: String(limit),
      srprop: "",
    }),
  );
  return (body.query?.search ?? []).map((r) => r.title).filter((t) => !SEARCH_SKIP.test(t));
}
