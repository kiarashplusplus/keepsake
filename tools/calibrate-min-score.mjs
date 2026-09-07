/**
 * Re-derives `MIN_SCORE` in `apps/api/src/search/search.ts` against the real
 * embedding model (issue #38, runbook step 4). Not part of CI: it spends real
 * Workers AI calls and needs a credential.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node tools/calibrate-min-score.mjs
 *
 * Why this exists at all. MIN_SCORE is not a relevance classifier — it is a
 * degenerate-result floor. Vectorize always returns its topK nearest
 * neighbours, with no "no results" answer at the API level, so without a floor
 * the FTS fallback for "the index holds nothing relevant" can never fire. The
 * number therefore has to sit BELOW the score of a genuine match and ABOVE the
 * score of a query that is nowhere near anything in the index. This script
 * measures both of those distributions instead of asserting them, and prints
 * the gap so the choice is arithmetic rather than taste.
 *
 * It deliberately reproduces the corpus shape `embeddingText()` builds
 * (title \n story \n "name: value" aspect lines), because the floor has to
 * hold against the strings actually in the index, not against bare queries.
 */
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const MODEL = "@cf/baai/bge-base-en-v1.5"; // must equal MODELS.embedding
if (!ACCOUNT || !TOKEN) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(1);
}

/** Mirrors `embeddingText()` in apps/api/src/search/embedding.ts. */
const embeddingText = (title, story, aspects) =>
  [title, story, ...aspects.map(([n, v]) => `${n}: ${v}`)].join("\n");

const LISTINGS = [
  ["teapot", "Grandmother's copper teapot",
   "She brought it over from Isfahan in 1974 and it sat on every stove she ever owned. The handle is worn smooth on one side from forty years of the same grip. Still holds water, still whistles.",
   [["material", "copper"], ["condition", "well-loved"], ["era", "1970s"]]],
  ["sextant", "Brass sextant, decorative",
   "Belonged to my father who never sailed a day in his life but liked the look of it on the shelf. Mirrors are intact, the scale still moves. More of an object than an instrument at this point.",
   [["material", "brass"], ["condition", "good"]]],
  ["bike", "Blue mountain bike, 21 speed",
   "Rode this all through college and then it lived in a garage for a decade. Tires need replacing and the rear derailleur is fussy but the frame is straight and there is no rust.",
   [["colour", "blue"], ["condition", "needs work"]]],
  ["quilt", "Hand-stitched patchwork quilt",
   "My aunt made this from my grandfather's shirts after he passed. Every square is a shirt he actually wore. It is heavier than it looks and one corner has come loose.",
   [["material", "cotton"], ["condition", "fair"]]],
  ["typewriter", "Olivetti Lettera 32 typewriter",
   "I wrote a whole terrible novel on this in my twenties. The ribbon is dry and needs replacing, and the letter e sticks if you go too fast, but every key strikes.",
   [["brand", "Olivetti"], ["condition", "working"]]],
  ["skates", "Leather ice skates, women's 7",
   "Bought secondhand at a rink sale in Minnesota and used for exactly one winter before I admitted I do not like being cold. Blades are sharp, leather is stiff but sound.",
   [["size", "7"], ["material", "leather"]]],
  // Deliberately zero-aspect, per issue #40 — the case FTS handles worst.
  ["lamp", "Small brass reading lamp",
   "It threw a warm circle on the left side of the bed for eleven years and I read most of what I have read underneath it. Rewired safely in 2019. The shade has a small dent.",
   []],
  ["records", "Box of jazz LPs, about forty",
   "Mostly Blue Note pressings from the sixties and seventies, mostly played, a few still sealed. Sleeves are shelf-worn. I am moving and cannot take the weight.",
   [["genre", "jazz"], ["count", "40"]]],
  // Terse listings. A short story gives the encoder very little to work with,
  // which is where a true match scores lowest — the low end of the true
  // distribution is what actually constrains the floor.
  ["highchair", "Wooden high chair", "Used it for two kids. Solid. Straps are fine.", []],
  ["mixer", "KitchenAid stand mixer", "Works. Bowl included. Missing the dough hook.", [["brand", "KitchenAid"]]],
  ["tent", "Two-person tent", "Camped maybe six nights total. No tears. Poles all there.", [["capacity", "2"]]],
  ["crib", "Convertible crib, no mattress",
   "Both of ours slept in it. It converts to a toddler bed and we still have the rail. Assembly hardware is in a bag taped underneath.",
   [["condition", "good"]]],
  ["guitar", "Nylon-string classical guitar",
   "I took six months of lessons in 2011 and stopped. It has been in its case since. Needs new strings and a proper setup but the neck is straight.",
   [["type", "classical"], ["condition", "good"]]],
  ["binoculars", "Pair of 10x50 binoculars",
   "My mother used these for birds from her kitchen window every morning for years. One eyecup is cracked. The optics are clear.",
   [["magnification", "10x50"]]],
  ["cookware", "Cast iron skillet, 12 inch",
   "Seasoned over about fifteen years of Sunday breakfasts. Never washed with soap. There is a small chip on the handle end.",
   [["material", "cast iron"], ["size", "12 inch"]]],
  ["desk", "Oak writing desk with two drawers",
   "My grandfather did his correspondence at this for decades and I did my homework at it. One drawer sticks in humid weather. Heavy — bring a friend.",
   [["material", "oak"]]],
  ["stroller", "Umbrella stroller, folds flat",
   "Took this through three airports and it never once jammed. The canopy has faded on one side from sun.",
   []],
  ["telescope", "Refractor telescope on a tripod",
   "Bought with real enthusiasm and used four times. Comes with two eyepieces. The finder scope alignment screw is missing.",
   [["type", "refractor"]]],
  ["dishes", "Set of blue willow china, service for eight",
   "This was my aunt's wedding china and it came out twice a year. Two saucers are chipped, everything else is intact.",
   [["pattern", "blue willow"], ["service", "8"]]],
];

const CASES = [
  // [query, id of the listing it SHOULD match, label]
  ["family heirloom kettle for boiling water", "teapot", "related"],
  ["antique nautical navigation instrument", "sextant", "related"],
  ["bicycle for commuting, needs some repair", "bike", "related"],
  ["handmade blanket sewn from old clothing", "quilt", "related"],
  ["vintage manual writing machine", "typewriter", "related"],
  ["winter sports footwear with blades", "skates", "related"],
  ["a bedside light to read by", "lamp", "related (zero-aspect, #40)"],
  ["vinyl record collection", "records", "related"],
  // Hard cases: oblique phrasing, or a terse listing with little to encode.
  // These probe the LOW end of the true-match distribution, which is what a
  // floor actually has to clear.
  ["something for feeding a toddler at the table", "highchair", "hard (terse + oblique)"],
  ["appliance for making bread dough", "mixer", "hard (terse + oblique)"],
  ["gear for sleeping outdoors", "tent", "hard (terse + oblique)"],
  ["where a baby sleeps", "crib", "hard (oblique)"],
  ["instrument with six strings I could learn on", "guitar", "hard (oblique)"],
  ["for watching birds far away", "binoculars", "hard (oblique)"],
  ["heavy pan for frying eggs", "cookware", "hard (oblique)"],
  ["furniture to put a laptop on and work", "desk", "hard (oblique)"],
  ["something to push a baby around in", "stroller", "hard (oblique)"],
  ["equipment for looking at planets", "telescope", "hard (oblique)"],
  ["plates and cups for a dinner party", "dishes", "hard (oblique)"],
];

// Queries with no plausible answer anywhere in this corpus. These set the
// noise floor: whatever Vectorize returns for these is what MIN_SCORE must
// reject, because it will return SOMETHING regardless.
const OFF_CORPUS = [
  ["quarterly deferred tax liability reconciliation", "unrelated (abstract)"],
  ["asdkj qwe zxcv hjkl piou", "gibberish"],
  ["symptoms of feline hyperthyroidism", "unrelated (concrete)"],
  ["", "blank-ish"],
  ["ةيبرعلا ةغللا سيردت", "non-English script"],
  ["refinance a thirty year fixed mortgage rate", "unrelated (abstract)"],
  ["kubernetes ingress controller tls termination", "unrelated (technical)"],
  ["zzzzz zzzzz zzzzz", "degenerate repetition"],
];

async function embedAll(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: batch }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(`AI call failed: ${JSON.stringify(json.errors)}`);
    out.push(...json.result.data);
  }
  return out;
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const corpusTexts = LISTINGS.map(([, t, s, a]) => embeddingText(t, s, a));
const ids = LISTINGS.map(([id]) => id);
const queries = [...CASES.map((c) => c[0]), ...OFF_CORPUS.map((c) => c[0])];

const [corpusVecs, queryVecs] = [await embedAll(corpusTexts), await embedAll(queries)];

// Sanity: a constant/degenerate model would make every one of these identical.
const distinct = new Set(corpusVecs.map((v) => v.slice(0, 4).join(","))).size;
console.log(`model: ${MODEL}`);
console.log(`dims: ${corpusVecs[0].length}  distinct corpus vectors: ${distinct}/${corpusVecs.length}`);
if (corpusVecs[0].length !== 768) throw new Error("dimension mismatch vs index");
if (distinct !== corpusVecs.length) throw new Error("degenerate model: corpus vectors collapse");

const trueHits = [];
const wrongDoc = [];
const offCorpusTop = [];

console.log("\n--- on-corpus queries: score of the intended listing, and its rank ---");
for (let i = 0; i < CASES.length; i++) {
  const [q, want, label] = CASES[i];
  const scores = corpusVecs.map((v, j) => [ids[j], cosine(queryVecs[i], v)]).sort((a, b) => b[1] - a[1]);
  const rank = scores.findIndex(([id]) => id === want) + 1;
  const got = scores.find(([id]) => id === want)[1];
  trueHits.push(got);
  for (const [id, s] of scores) if (id !== want) wrongDoc.push(s);
  console.log(`  ${got.toFixed(4)}  rank ${rank}/${ids.length}  top=${scores[0][0]}  ${label.padEnd(24)} "${q}"`);
}

console.log("\n--- off-corpus queries: the best score Vectorize would still return ---");
for (let i = 0; i < OFF_CORPUS.length; i++) {
  const [q, label] = OFF_CORPUS[i];
  const v = queryVecs[CASES.length + i];
  const best = Math.max(...corpusVecs.map((c) => cosine(v, c)));
  offCorpusTop.push(best);
  console.log(`  ${best.toFixed(4)}  ${label.padEnd(24)} "${q}"`);
}

const min = (a) => Math.min(...a), max = (a) => Math.max(...a);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log("\n--- distributions ---");
console.log(`  true match         min ${min(trueHits).toFixed(4)}  mean ${mean(trueHits).toFixed(4)}  max ${max(trueHits).toFixed(4)}`);
console.log(`  wrong doc, on-corpus query   min ${min(wrongDoc).toFixed(4)}  mean ${mean(wrongDoc).toFixed(4)}  max ${max(wrongDoc).toFixed(4)}`);
console.log(`  off-corpus best    min ${min(offCorpusTop).toFixed(4)}  mean ${mean(offCorpusTop).toFixed(4)}  max ${max(offCorpusTop).toFixed(4)}`);

const floor = min(trueHits);
const ceiling = max(offCorpusTop);
console.log(`\n  lowest true match : ${floor.toFixed(4)}`);
console.log(`  highest off-corpus: ${ceiling.toFixed(4)}`);
console.log(ceiling < floor
  ? `  SEPARABLE. Any MIN_SCORE in (${ceiling.toFixed(4)}, ${floor.toFixed(4)}) rejects every off-corpus query and keeps every true match.\n  Midpoint: ${((ceiling + floor) / 2).toFixed(4)}`
  : `  NOT SEPARABLE by an absolute cutoff: off-corpus (${ceiling.toFixed(4)}) >= weakest true match (${floor.toFixed(4)}).\n  A floor set above ${ceiling.toFixed(4)} would drop real matches; one set below cannot reject a nowhere-near query.`);
