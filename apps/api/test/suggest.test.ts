import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MODELS } from "../src/models.js";
import { todayISO } from "../src/moderation/budget.js";
import { authHeaders, freshClientIp, freshOwnerToken, readErr, readOk, setTestEnvVar, uploadPhoto } from "./helpers.js";
import type { PublicPhoto } from "@keepsake/contracts/photo";

interface SuggestResponseBody {
  suggestion: {
    subject: string;
    title: string;
    category: string;
    condition: string;
    aspects: { name: string; value: string }[];
  } | null;
}

const VALID_SUGGESTION_JSON = JSON.stringify({
  subject: "a stoneware mug",
  title: "Chipped stoneware mug",
  category: "home_kitchen",
  condition: "glaze worn at the rim",
  aspects: [
    { name: "object", value: "mug" },
    { name: "material", value: "stoneware" },
  ],
});

/** Installs a fake `env.AI.run` that only answers `MODELS.imageVision` calls
 * — mirrors moderation.test.ts's `mockAi` helper, minus the text-model
 * branch this route never calls. */
function mockSuggestAi(handler: (callIndex: number) => unknown): void {
  let callIndex = 0;
  const run = async (model: string) => {
    if (model !== MODELS.imageVision) {
      throw new Error(`mockSuggestAi: unexpected model ${model}`);
    }
    const result = handler(callIndex);
    callIndex += 1;
    return result;
  };
  env.AI.run = run as unknown as Ai["run"];
}

async function suggestFor(photoId: string, token: string): Promise<Response> {
  return SELF.fetch(`http://x/api/photos/${photoId}/suggest`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

/** Every successful (and every `SUGGEST_DAILY_BUDGET=0`-denied-at-zero-cost)
 * call in this file shares one KV key for the day (`budget:suggest:<date>`,
 * see `moderation/budget.ts`'s "Global key format" doc comment) — tests
 * earlier in this file that actually reach `checkAndBump` leave that counter
 * non-zero. A test asserting "the Nth call is refused" for a specific,
 * non-zero N needs to start from a known count or it becomes order-dependent
 * on how many prior tests in the file happened to succeed first. */
async function resetGlobalSuggestBudget(): Promise<void> {
  await env.KV.delete(`budget:suggest:${todayISO()}`);
}

beforeEach(() => {
  // Every test in this file exercises the real (mocked) AI call path, not
  // the MOCK_AI fixture — the dedicated `MOCK_AI=1` test below flips it back
  // on for its own assertion and doesn't need to restore it since vitest
  // resets isolated storage/bindings between test files, not between tests
  // in the same file, but each `beforeEach` here re-asserts it explicitly so
  // test order within the file can never matter.
  env.MOCK_AI = "0";
});

describe("POST /api/photos/:id/suggest", () => {
  it("happy path: returns a valid suggestion built from the model's reply", async () => {
    mockSuggestAi(() => VALID_SUGGESTION_JSON);
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion).not.toBeNull();
    expect(body.suggestion?.title).toBe("Chipped stoneware mug");
    expect(body.suggestion?.category).toBe("home_kitchen");
    expect(body.suggestion?.aspects).toEqual([
      { name: "object", value: "mug" },
      { name: "material", value: "stoneware" },
    ]);
  });

  it("recovers a reply wrapped in a markdown code fence", async () => {
    // `stripCodeFences` mirrors moderation/image.ts exactly: it strips a
    // leading/trailing ``` fence, not prose surrounding one — matching what
    // the model actually does when asked for "only the JSON object" and
    // answering with a fenced block instead of bare JSON.
    mockSuggestAi(() => `\`\`\`json\n${VALID_SUGGESTION_JSON}\n\`\`\``);
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion?.title).toBe("Chipped stoneware mug");
  });

  it("two malformed replies in a row -> suggestion: null, never a 500", async () => {
    mockSuggestAi(() => "not json at all {{{");
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion).toBeNull();
  });

  it("one malformed reply then a valid parse on the retry -> a suggestion", async () => {
    mockSuggestAi((callIndex) => (callIndex === 0 ? "not json {" : VALID_SUGGESTION_JSON));
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion?.title).toBe("Chipped stoneware mug");
  });

  it("AI.run throwing -> suggestion: null, never a 500", async () => {
    mockSuggestAi(() => {
      throw new Error("simulated Workers AI outage");
    });
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion).toBeNull();
  });

  // Guard validated by breaking it: relaxing PhotoSuggestionSchema's
  // `category` field in packages/contracts/src/photo.ts to a bare
  // `z.string()` makes this test fail — the model's hallucinated category
  // would then reach the client as `{ suggestion: { category:
  // "vintage_collectibles", ... } }` instead of being rejected as
  // unparseable, confirming the schema (not the route) is what stops a bad
  // suggestion from producing a form the giver can't submit.
  it("a category outside the real enum makes the whole reply fail validation -> suggestion: null", async () => {
    mockSuggestAi(() =>
      JSON.stringify({
        subject: "a stoneware mug",
        title: "Chipped stoneware mug",
        category: "vintage_collectibles",
        condition: "",
        aspects: [],
      }),
    );
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion).toBeNull();
  });

  it("an over-length title makes the whole reply fail validation -> suggestion: null", async () => {
    mockSuggestAi(() =>
      JSON.stringify({
        subject: "a stoneware mug",
        title: "x".repeat(81),
        category: "home_kitchen",
        condition: "",
        aspects: [],
      }),
    );
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion).toBeNull();
  });

  it("404s for a photo owned by someone else, not 403", async () => {
    mockSuggestAi(() => VALID_SUGGESTION_JSON);
    const ownerA = freshOwnerToken();
    const ownerB = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token: ownerA }));
    // Register ownerB as a real owner first — this route doesn't
    // createIfMissing, so an entirely unseen token would 401 before ever
    // reaching the ownership check this test is about.
    await uploadPhoto({ token: ownerB });

    const res = await suggestFor(photo.id, ownerB);
    expect(res.status).toBe(404);
    const error = await readErr(res);
    expect(error.code).toBe("not_found");
  });

  it("404s for an unknown photo id", async () => {
    const token = freshOwnerToken();
    await uploadPhoto({ token }); // establish the owner
    const res = await suggestFor("nonexistent", token);
    expect(res.status).toBe(404);
  });

  it("401s with no Authorization header", async () => {
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
    const res = await SELF.fetch(`http://x/api/photos/${photo.id}/suggest`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("an exhausted daily budget 429s with a Retry-After header", async () => {
    mockSuggestAi(() => VALID_SUGGESTION_JSON);
    setTestEnvVar("SUGGEST_DAILY_BUDGET", "0");
    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const error = await readErr(res);
    expect(error.code).toBe("rate_limited");
    expect(typeof error.retryAfter).toBe("number");

    setTestEnvVar("SUGGEST_DAILY_BUDGET", "1000");
  });

  // Issue #45: a var declared in wrangler.toml and read by nothing (or read
  // but ignored by a hardcoded check) is the exact bug this project has
  // already shipped twice (MAX_PHOTOS/IMAGE_TRANSFORMS_ENABLED, RL_READ).
  // Denying at budget=0 (the test above) proves *some* guard exists, but a
  // route that special-cased "if the configured limit is 0, deny" would pass
  // that test while never actually reading the var for any other value. This
  // test moves the ceiling to two different non-zero numbers and checks the
  // refusal point moves with it — the only way that happens is if the value
  // read from `env.SUGGEST_DAILY_BUDGET` is the number actually compared
  // against the running count.
  it("the global daily budget's refusal point tracks SUGGEST_DAILY_BUDGET's value, not a hardcoded number", async () => {
    mockSuggestAi(() => VALID_SUGGESTION_JSON);
    setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", "1000"); // keep the per-IP ceiling out of the way

    await resetGlobalSuggestBudget();
    setTestEnvVar("SUGGEST_DAILY_BUDGET", "1");
    const tokenA = freshOwnerToken();
    const photoA = await readOk<PublicPhoto>(await uploadPhoto({ token: tokenA }));
    const firstAtOne = await suggestFor(photoA.id, tokenA);
    expect(firstAtOne.status).toBe(200);
    // A different owner and a different CF-Connecting-IP (authHeaders mints
    // a fresh one per call) — the only counter that can explain this denial
    // is the *global* one, since this caller's own per-IP count is still 0.
    const tokenB = freshOwnerToken();
    const photoB = await readOk<PublicPhoto>(await uploadPhoto({ token: tokenB }));
    const secondAtOne = await suggestFor(photoB.id, tokenB);
    expect(secondAtOne.status).toBe(429);

    // Raise the ceiling to 3 and reset the counter: now three distinct
    // callers get through and a fourth is refused. If the earlier denial had
    // come from something other than SUGGEST_DAILY_BUDGET, raising the var
    // would not move where the refusal starts.
    await resetGlobalSuggestBudget();
    setTestEnvVar("SUGGEST_DAILY_BUDGET", "3");
    for (let i = 0; i < 3; i++) {
      const token = freshOwnerToken();
      const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
      const res = await suggestFor(photo.id, token);
      expect(res.status).toBe(200);
    }
    const tokenOver = freshOwnerToken();
    const photoOver = await readOk<PublicPhoto>(await uploadPhoto({ token: tokenOver }));
    const overBudget = await suggestFor(photoOver.id, tokenOver);
    expect(overBudget.status).toBe(429);
    const error = await readErr(overBudget);
    expect(error.code).toBe("rate_limited");

    setTestEnvVar("SUGGEST_DAILY_BUDGET", "1000");
    setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", "30");
  });

  // SUGGEST_IP_DAILY_BUDGET had no HTTP-level coverage at all before this —
  // only the generic `checkAndBump` primitive was exercised (budget.test.ts),
  // with numbers unrelated to this route's actual env var. This drives the
  // real route from one fixed CF-Connecting-IP, with the global budget wide
  // open, so any refusal is attributable only to the per-IP ceiling — then
  // repeats it at a second value to prove that ceiling, too, tracks the var
  // rather than a number baked into the route.
  it("the per-IP daily budget's refusal point tracks SUGGEST_IP_DAILY_BUDGET's value even with the global budget wide open", async () => {
    mockSuggestAi(() => VALID_SUGGESTION_JSON);
    setTestEnvVar("SUGGEST_DAILY_BUDGET", "1000");

    const runFromOneIpWithLimit = async (limit: string, allowedCount: number) => {
      setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", limit);
      const token = freshOwnerToken();
      const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
      const ip = freshClientIp();
      const headers = { Authorization: `Bearer ${token}`, "CF-Connecting-IP": ip };
      const call = () => SELF.fetch(`http://x/api/photos/${photo.id}/suggest`, { method: "POST", headers });

      for (let i = 0; i < allowedCount; i++) {
        const res = await call();
        expect(res.status).toBe(200);
      }
      const overBudget = await call();
      expect(overBudget.status).toBe(429);
      const error = await readErr(overBudget);
      expect(error.code).toBe("rate_limited");
    };

    await runFromOneIpWithLimit("2", 2);
    await runFromOneIpWithLimit("1", 1);

    setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", "30");
    setTestEnvVar("SUGGEST_DAILY_BUDGET", "1000");
  });

  it("MOCK_AI=1 never calls env.AI and still returns a canned suggestion", async () => {
    // `env.MOCK_AI = "1"` doesn't type-check directly — wrangler.toml/
    // vitest.config.ts give MOCK_AI the string-literal type "0", not the
    // general `string` a real runtime value can hold (see env.ts's
    // `isMockAi` comment). `setTestEnvVar` is the one place that widens it
    // back for exactly this purpose.
    setTestEnvVar("MOCK_AI", "1");
    env.AI.run = (() => {
      throw new Error("MOCK_AI must never call env.AI.run");
    }) as unknown as Ai["run"];

    const token = freshOwnerToken();
    const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));

    const res = await suggestFor(photo.id, token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    expect(body.suggestion).not.toBeNull();

    setTestEnvVar("MOCK_AI", "0");
  });
});
