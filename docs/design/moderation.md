# Moderation

Status: `[QA]` (M1 API side implemented; needs a real Workers AI run on preview per M1 DoD — see "M1 status" below).

Open models pre-screen every listing before it's public. Minimal prohibited list: auto-reject
only clear illegality; anything borderline is held for Kiarash, the sole admin, to approve.
`apps/api/src/models.ts` is the only file allowed to name a Workers AI model id — everywhere
else is enforced by `tools/preflight`'s `models` check.

## Pipeline (`apps/api/src/moderation/pipeline.ts: moderateListing(env, listingId, version)`)

1. **Local checks** (no AI): title 4–80 chars, story 20–2000, category enum, 1–5 owned photos.
   Email/phone/URL regex in title+story → `rejected` (`contact_in_story`) — privacy and a bypass
   block in one move.
2. **Budget gate**: KV daily counters `mod_text`/`mod_image` (ported from Bayan's
   `worker/src/budget.ts`). Exhausted → stays `pending`, event `reason=budget`, cron retries
   after midnight UTC.
3. **Text**: Llama Guard 3 (`@cf/meta/llama-guard-3-8b`) on `title\n\nstory`, 20s timeout.
4. **Images**: each photo's 640px thumbnail (not the full image — cheaper, still enough signal)
   to Llama 3.2 Vision, strict JSON prompt, `temperature 0`, 30s timeout, one retry on a parse
   failure before giving up to `error`.
5. **Decide** (`decide.ts`, pure, exhaustively tested):
   - Text `S1 S3 S4 S9` (violent crime, sex crimes, child exploitation, indiscriminate weapons) →
     `flag`; `S2 S7 S10 S12` (non-violent crime, privacy, hate, sexual content) → `review`.
   - Image `drugs ≥ 0.7` or `is_physical_object === false` → `flag`; any of
     `nsfw, violence, weapons, hate_symbols, personal_info ≥ 0.5` → `review`; else `pass`.
   - Any `error` → stays `pending` (cron retries, 3 attempts → `needs_review`). Any `flag` →
     `rejected` with a giver-facing reason from `@keepsake/contracts/listing`'s
     `MODERATION_REASONS`. Any `review`, no `flag` → `needs_review`, invisible until approved.
     All pass → `approved`.
   - **Fail-closed**: nothing auto-approves on an AI error. Update is guarded by
     `WHERE version = ?` so an edit racing the pipeline never gets approved against stale
     content.

## Testing

`apps/api/test/moderation.test.ts` mirrors Bayan's `envWithMockAI` pattern: stub `AI.run` per
model id, seed a miniflare D1, run the pipeline, assert the resulting rows — not that the source
text still says the right thing. Matrix: all-pass, S12→needs_review, S4→rejected, drugs 0.9→
rejected, nsfw 0.55→needs_review, malformed JSON once then valid, malformed twice→pending,
AI throws→pending, budget 0→pending/budget, stale version→no approval, cron escalation after
3 attempts.

## Open risk

Vision model cost/latency/JSON discipline is unmeasured until M1 runs against real traffic; the
fallback is `MODELS.imageVision → @cf/meta/llama-4-scout-17b-16e-instruct` if parse failures
exceed a few percent (plan Risk #4).

## M1 status (API side)

Implemented as described above, plus the routes and middleware it hangs off of: owner auth
(`src/middleware/ownerAuth.ts`), Turnstile (`src/middleware/turnstile.ts` — soft-passes with a
one-time log when `TURNSTILE_SECRET` is unset, per `.dev.vars.example`), burst + daily-budget
rate limiting (`src/middleware/rateLimit.ts`), idempotent listing creation
(`src/middleware/idempotency.ts`), photo upload/serve (`src/routes/photos.ts`,
`src/routes/images.ts`), geo lookup (`src/geo/lookup.ts`), and the listing CRUD + lifecycle
routes (`src/routes/listings.ts`, `src/routes/me.ts`). `apps/api/test/moderation.test.ts` covers
the full decision matrix from "Testing" above against a mocked `env.AI.run`, plus
`apps/api/test/{photos,listings,geo,imageSniff}.test.ts` for the surrounding routes; all green
locally (`pnpm --filter @keepsake/api test`).

Real Workers AI vision text/image calls (`Ai_Cf_Meta_Llama_Guard_3_8B_Output` /
`Ai_Cf_Meta_Llama_3_2_11B_Vision_Instruct_Messages`, both confirmed against the generated
`worker-configuration.d.ts` types) are wired but **unverified against live Workers AI** — the
M1 DoD's "vision path runs once against real Workers AI, parsed JSON lands in
`moderation_events`" needs a real preview deploy + a real listing post, which is outside this
API-only session. `sendMail()` (`src/email/sendMail.ts`) sends the verify-email stub through the
real `EMAIL` binding when `EMAIL_PROVIDER=cf` and it's configured, else logs `[email:stub]` — the
`GET /api/me/email/verify` endpoint itself is explicitly M3 scope, so that link is a placeholder
until then. Feed/requests/admin/recovery are out of scope for this session (M2–M4).

## Real-stack findings (preview, 2026-09-05)
- Vision (`@cf/meta/llama-3.2-11b-vision-instruct`) via `messages` + `image_url` data URI works, ~2.3–4 s per 640px thumb, ~15 neurons per call (3.2k prompt tokens). Workers AI hands back `response` as a **parsed object** when the model emits JSON; the extractor normalises it. An image-only user turn returns an empty response: always send a text part.
- Llama Guard 3 judges *descriptions of objects* leniently: a story describing explicit adult magazines came back `safe`. Text-side `review` will rarely fire; the vision pass and the report button carry borderline cases. This is consistent with the minimal-list decision. Revisit if reports show text-only abuse.
- Phone number in a story → `rejected` / `contact_in_story` before any model call, as designed.
- Cron retry (`*/5`) re-ran listings left `pending` by the earlier failure and approved them once the fix deployed.

## The vision model was copying our example (found and fixed 2026-09-06)

The image prompt used to show a filled-in JSON object as the "shape" to match:
`{"is_physical_object":true,"nsfw":0,...}`. The model copied those values instead of
classifying. Proof, all against `@cf/meta/llama-3.2-11b-vision-instruct` on the same
synthetic bar-chart image:

| Prompt | Answer |
|---|---|
| "In one sentence, what is in this image?" | "a horizontal bar chart … on a white background" |
| Filled-in example (what we shipped) | `{"is_physical_object":true,"notes":"not a person"}` |
| Placeholders + `subject` first | `{"subject":"a horizontal bar chart","is_photo_of_tangible_object":false}` |

So the model could see the image perfectly well; the prompt was handing it a safe answer to
copy. Every score was decorative, and the two image auto-reject rules (`drugs >= 0.7`,
`is_physical_object === false`) could never fire. Unit tests stayed green throughout because
they mock `env.AI.run` — the mock returns whatever verdict the test wants, so it can never
catch a prompt that stops the real model from thinking.

Fix in `apps/api/src/moderation/prompts.ts`: placeholders (`<true|false>`, `<0.0-1.0>`) instead
of values, and a `subject` field the model must fill in first, because generation is left to
right and naming the thing forces a look. Verified live afterwards: the same bar chart returns
`subject: "Gray horizontal bars on white background"`, `is_physical_object: false` → listing
`rejected` / `not_an_object`; a real photograph returns an accurate subject and passes.

**When editing this prompt, re-run both cases against preview.** Green unit tests mean nothing
here.
