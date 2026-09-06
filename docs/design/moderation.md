# Moderation

Status: `[TODO]` (M1).

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
