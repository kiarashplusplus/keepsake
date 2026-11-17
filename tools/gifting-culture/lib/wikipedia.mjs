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
 * Resolve candidate titles in batches of 50. Returns a Map from each
 * requested title to the page it lands on (after normalisation and
 * redirects), or nothing if it does not exist or is a disambiguation page.
 */
export async function resolveTitles(client, titles) {
  const resolved = new Map();
  const unique = [...new Set(titles)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const body = await client.getJson(
      api({
        action: "query",
        redirects: "1",
        prop: "pageprops",
        ppprop: "disambiguation",
        titles: batch.join("|"),
      }),
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
      resolved.set(requested, page.title);
    }
  }
  return resolved;
}

/** Plain text plus the revision it came from. */
export async function fetchArticle(client, title) {
  const body = await client.getJson(
    api({
      action: "query",
      redirects: "1",
      prop: "extracts|revisions|pageprops",
      explaintext: "1",
      exsectionformat: "wiki",
      rvprop: "ids|timestamp",
      ppprop: "wikibase_item|disambiguation",
      titles: title,
    }),
  );
  const page = body.query?.pages?.[0];
  if (!page || page.missing || page.pageprops?.disambiguation !== undefined || !page.extract)
    return null;
  const revision = page.revisions?.[0] ?? {};
  return {
    title: page.title,
    pageId: page.pageid,
    revisionId: revision.revid ?? null,
    revisionTimestamp: revision.timestamp ?? null,
    wikidataId: page.pageprops?.wikibase_item ?? null,
    text: page.extract,
  };
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
