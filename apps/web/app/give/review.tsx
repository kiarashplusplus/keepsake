// Give flow — step 5 of 5: review, submit, and the "reviewing" state
// (breathing seal -> live/rejected/held/timeout). Submitting when
// `draft.listingId` is already set (a prior rejected attempt, or an
// `/give?edit=<id>` prefill) PATCHes that listing instead of creating a new
// one, which is what makes the rejected-state "Edit" button below actually
// resubmit the same listing rather than spawning a duplicate.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import type { CreateListingInput, OwnerListing as OwnerListingT } from "@keepsake/contracts/listing";
import { MODERATION_REASONS } from "@keepsake/contracts/listing";
import { COUNTRY_LABELS } from "@keepsake/contracts/geo";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Print } from "@/ui/Print";
import { Card } from "@/ui/Surface";
import { Stamp, type StampState } from "@/ui/Stamp";
import { Turnstile, type TurnstileHandle, type TurnstileStatus } from "@/ui/Turnstile";
import { Page } from "@/ui/Page";
import { useColors } from "@/ui/theme";
import { AgeGateField, isAgeGateValid } from "@/features/ageGate/AgeGateField";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { coverPhoto, makeClientId } from "@/features/give/giveDraft";
import { editStepForReason, resolveReviewOutcome } from "@/features/give/reviewOutcome";
import { createListing, updateListing } from "@/api/listings";
import { getMyListing } from "@/api/me";
import { ApiError } from "@/api/client";
import { useDraftPhotoSource } from "@/features/give/photoSource";
import { clampCardAspectRatio } from "@/lib/masonry";
import { storyExcerpt } from "@/lib/storyExcerpt";
import { shareListing } from "@/lib/share";
import { useToast } from "@/ui/Toast";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

type Phase = "review" | "submitting" | "polling";

export default function GiveReview(): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const colors = useColors();
  const { draft, dispatch } = useGiveDraft();
  const [phase, setPhase] = React.useState<Phase>("review");
  const [turnstileStatus, setTurnstileStatus] = React.useState<TurnstileStatus>({ status: "pending" });
  const turnstileRef = React.useRef<TurnstileHandle>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  // The card preview is best-effort: a rasterisation failure must not leave
  // a broken image on the one screen that says "It's live."
  const [cardFailed, setCardFailed] = React.useState(false);
  const [dateOfBirth, setDateOfBirth] = React.useState("");
  const [dobTouched, setDobTouched] = React.useState(false);
  const ageGateValid = isAgeGateValid(dateOfBirth);
  const [listing, setListing] = React.useState<OwnerListingT | null>(null);
  const [timedOut, setTimedOut] = React.useState(false);
  const idempotencyKeyRef = React.useRef(makeClientId());

  const turnstileReady = turnstileStatus.status === "ready" || turnstileStatus.status === "unconfigured";
  const turnstileToken = turnstileStatus.status === "ready" ? turnstileStatus.token : "";

  const photoIds = draft.photos.filter((photo) => photo.status === "done" && photo.id !== null).map((photo) => photo.id as string);
  const cover = coverPhoto(draft);
  const coverSource = useDraftPhotoSource(cover);

  React.useEffect(() => {
    if (phase !== "polling" || listing === null || listing.status !== "pending") return undefined;

    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setTimedOut(true);
        clearInterval(intervalId);
        return;
      }
      getMyListing(listing.id)
        .then((detail) => {
          setListing(detail);
          if (detail.status !== "pending") clearInterval(intervalId);
        })
        .catch(() => {
          // A transient poll failure isn't worth surfacing; the next tick retries.
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [phase, listing]);

  const trackedStatusRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (listing === null || trackedStatusRef.current === listing.status) return;
    trackedStatusRef.current = listing.status;
    if (listing.status === "approved") {
      // A Google Ads conversion used to be reported here too. Removed with
      // the rest of the ads plumbing (#175): it could never fire, because no
      // deploy passed a tag id. Our own `AnalyticsEvents.GiveLive` above is
      // unaffected — it is the product telemetry, not the ad pipeline.
      track(AnalyticsEvents.GiveLive);
    }
    if (listing.status === "rejected") track(AnalyticsEvents.GiveRejected);
  }, [listing]);

  async function handleSubmit(): Promise<void> {
    setDobTouched(true);
    if (photoIds.length === 0 || !ageGateValid) return;
    setSubmitError(null);
    setPhase("submitting");

    // Issue #36: forward whatever the cover photo's suggestion actually
    // read off the photo, straight through — unlike `title` (which the
    // reducer only ever applies if the giver hasn't already typed one, see
    // `giveDraft.ts`'s `set_suggestion` case), aspects aren't a form field
    // the giver can edit at all, so there's no "already set" to defer to.
    // Cache-keyed by photo id, not gated on `appliedSuggestionPhotoId`
    // (which only tracks whether `title` was ever overwritten) — if the
    // cover has a cached suggestion at all, its aspects apply. `?? []`
    // covers every other case identically: no suggestion fetched yet, the
    // fetch failed, or MOCK_AI/the model returned none — a listing with
    // zero aspects is always a valid, fully-visible listing (see
    // apps/api/test/aspects.test.ts).
    const coverAspects = cover !== null && cover.id !== null ? (draft.suggestions[cover.id]?.aspects ?? []) : [];

    const input: CreateListingInput = {
      title: draft.title,
      story: draft.story,
      category: draft.category,
      country: draft.country,
      postal_code: draft.postalCode,
      photo_ids: photoIds,
      // Issue #64: sent once, validated again server-side by the identical
      // `DateOfBirthSchema`, and never persisted beyond the resulting
      // `age_attested_at` timestamp — see `AgeGateField`'s doc comment.
      date_of_birth: dateOfBirth,
      aspects: coverAspects,
      ...(draft.email.trim() !== "" ? { email: draft.email.trim() } : {}),
    };

    try {
      const result =
        draft.listingId !== null
          ? await updateListing(draft.listingId, input)
          // `idempotencyKeyRef` is created once via `useRef` and never
          // regenerated, so a retry after a failed attempt (including a
          // `turnstile_failed` one, below) reuses the same key rather than
          // minting a new one — the whole point being that a retry can't
          // double-create the listing.
          : await createListing(input, { turnstileToken, idempotencyKey: idempotencyKeyRef.current });

      dispatch({ type: "set_listing_id", listingId: result.id });
      setListing(result);
      setPhase("polling");
      track(AnalyticsEvents.GiveSubmitted);
    } catch (error) {
      if (error instanceof ApiError && error.code === "turnstile_failed") {
        // The token was spent (or rejected) server-side; the widget's own
        // token is now useless even though our state still calls it
        // "ready". Reset it and wait for a fresh one before allowing
        // another attempt — the idempotency key above is untouched, so the
        // retry still can't double-create.
        turnstileRef.current?.reset();
        setTurnstileStatus({ status: "pending" });
      }
      setSubmitError(error instanceof ApiError ? error.message : "That didn't go through. Try again.");
      setPhase("review");
    }
  }

  async function handleShare(): Promise<void> {
    if (listing === null) return;
    const result = await shareListing({ id: listing.id, title: listing.title, surface: "give_review" });
    if (result === "copied") toast.show("Link copied.");
    if (result === "failed") toast.show("Couldn't share — try copying the link from the address bar.");
  }

  function handleGiveAnother(): void {
    dispatch({ type: "reset" });
    router.replace("/give");
  }

  function handleEdit(step: "photos" | "story"): void {
    router.push(step === "photos" ? "/give" : "/give/story");
  }

  if (phase === "polling" && listing !== null) {
    const outcome = resolveReviewOutcome(listing.status, listing.moderation_reason, timedOut);
    const stampState: StampState = outcome.kind === "approved" ? "settled" : "breathing";
    const stampLabel =
      outcome.kind === "approved"
        ? "Live"
        : outcome.kind === "rejected"
          ? "Not approved"
          : outcome.kind === "needs_review"
            ? "Held"
            : "On review";

    // The reviewing state: centred, the stamp on top, an eyebrow naming the
    // moment and the outcome in display type — same shape for every outcome.
    return (
      // See app/give/index.tsx's comment on why this step wraps itself in a
      // `Page` rather than the shell doing it once.
      <Page>
        <Card style={{ gap: space.xl, alignItems: "center", paddingVertical: space.xxl }}>
          <Stamp state={stampState} label={stampLabel} />

          {outcome.kind === "waiting" ? (
            <View style={{ gap: space.sm, alignItems: "center" }}>
              <Eyebrow align="center">Taking a look</Eyebrow>
              <Text variant="displayLg" style={{ textAlign: "center" }}>
                Your keepsake is being looked over.
              </Text>
              <Text variant="bodyLg" color="textSecondary" style={{ textAlign: "center" }}>
                Usually less than a minute.
              </Text>
            </View>
          ) : null}

          {outcome.kind === "approved" ? (
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <View style={{ gap: space.sm, alignItems: "center" }}>
                <Eyebrow align="center">Stamped</Eyebrow>
                <Text variant="displayLg" style={{ textAlign: "center" }}>
                  {"It's live."}
                </Text>
              </View>

              {/* The share card, exactly as a friend will see it when the link
                  unfurls in iMessage or WhatsApp. This is the only moment the
                  giver can see that artifact at all, and it doubles as a warm
                  cache: fetching it here renders the card and stores it in R2
                  and at the edge before anyone clicks the link.

                  No `?v=` fingerprint. The route treats `v` as advisory and
                  never as a selector, and this listing was created seconds
                  ago, so there is no earlier version to bust — while putting
                  the fingerprint on `PublicListing` (the plan's original
                  shape) would mean computing a SHA-256 per listing on every
                  feed response for a field one screen uses.

                  Hidden on error rather than left as a broken image: if
                  rasterisation fails the unfurl still degrades to the raw
                  photo (see `routes/ogCard.ts`), and there is nothing useful
                  to say about it here. */}
              {cardFailed ? null : (
                <View style={{ width: "100%", maxWidth: 480, gap: space.xs }}>
                  <ExpoImage
                    source={`/og/item/${listing.id}/card.png`}
                    style={{ width: "100%", aspectRatio: 1200 / 630 }}
                    contentFit="contain"
                    accessibilityLabel="Preview of the link card your friends will see"
                    onError={() => setCardFailed(true)}
                  />
                  <Text variant="caption" color="textSecondary" style={{ textAlign: "center" }}>
                    This is what your friends will see.
                  </Text>
                </View>
              )}

              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xl, flexWrap: "wrap", justifyContent: "center" }}>
                <Button label="Share" onPress={() => void handleShare()} />
                <Button
                  label="See it"
                  variant="link"
                  onPress={() => {
                    if (typeof window !== "undefined") window.location.assign(`/item/${listing.id}`);
                  }}
                />
              </View>
              <Button label="Give another" variant="ghost" onPress={handleGiveAnother} />
            </View>
          ) : null}

          {outcome.kind === "rejected" ? (
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <View style={{ gap: space.sm, alignItems: "center" }}>
                <Eyebrow align="center">Not quite</Eyebrow>
                <Text variant="displayLg" style={{ textAlign: "center" }}>
                  Not this time.
                </Text>
                <Text variant="bodyLg" color="textSecondary" style={{ textAlign: "center", maxWidth: 480 }}>
                  {outcome.reason !== null ? MODERATION_REASONS[outcome.reason] : "Something about this listing needs a change."}
                </Text>
              </View>
              <Button label="Edit" onPress={() => handleEdit(editStepForReason(outcome.reason))} />
            </View>
          ) : null}

          {outcome.kind === "needs_review" ? (
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <View style={{ gap: space.sm, alignItems: "center" }}>
                <Eyebrow align="center">Held</Eyebrow>
                <Text variant="displayLg" style={{ textAlign: "center" }}>
                  Taking a closer look.
                </Text>
                <Text variant="bodyLg" color="textSecondary" style={{ textAlign: "center" }}>
                  Usually within a day.
                </Text>
              </View>
              <Button label="See it in Mine" variant="link" onPress={() => router.push("/mine")} />
            </View>
          ) : null}

          {outcome.kind === "timeout" ? (
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <View style={{ gap: space.sm, alignItems: "center" }}>
                <Eyebrow align="center">Still checking</Eyebrow>
                <Text variant="bodyLg" color="textSecondary" style={{ textAlign: "center", maxWidth: 480 }}>
                  {"You can leave this page; it'll show up under Mine."}
                </Text>
              </View>
              <Button label="Go to Mine" variant="link" onPress={() => router.push("/mine")} />
            </View>
          ) : null}
        </Card>
      </Page>
    );
  }

  return (
    // See app/give/index.tsx's comment on why this step wraps itself in a
    // `Page` rather than the shell doing it once.
    <Page>
      <Card style={{ gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow>Last look</Eyebrow>
          <Text variant="displayLg">Take a last look.</Text>
        </View>

        {/* The listing as it will lie on the table: an actual print, laid
            out as the card this listing is about to become.

            Issue #218: the cover used to be a fixed 96x96 thumbnail pinned
            to the top-left of a full-width print, with the rest of the frame
            empty — so the one screen whose entire job is "this is what you
            are about to publish" was the one screen that did not look like
            the result. Everything below mirrors
            `src/features/feed/ListingCard.tsx`: the same 10px print padding,
            the photo filling the width at its own clamped aspect ratio, then
            the story excerpt, the title and one caption line, in that order
            and at the same type variants.

            Why not just render `ListingCard` here? It takes a
            `PublicListing` — an id, a resolved `place_name`/`admin1`, a
            `published_at`, `url_thumb`s the server has minted — and none of
            that exists yet at this point in the flow (the whole point of
            this screen is that nothing has been created). It also wraps
            itself in a `Link` to `/item/[id]`, which for a draft is a link
            to a page that does not exist. Mirroring its geometry against a
            `GiveDraft` is the honest version; the two are meant to be read
            side by side, so change them together. */}
        <Print tiltDeg={-1.5} style={{ alignSelf: "stretch", padding: 10 }}>
          {/* Source ladder in `features/give/photoSource.ts`, shared with
              the photos step's tiles: this session's object URL, else the
              owner-authed thumb route, else the blurhash alone. */}
          <View
            style={{
              width: "100%",
              // The draft photo carries the real pixel dimensions
              // (`giveDraft.ts`), so the print can be the right shape before
              // a single byte of the image has decoded — the same reason the
              // feed's masonry can lay itself out ahead of any load. `1`
              // only stands in for "no cover yet", which the Give it button
              // already refuses to submit.
              aspectRatio: cover !== null ? clampCardAspectRatio(cover.width, cover.height) : 1,
              overflow: "hidden",
              backgroundColor: colors.tableEdge,
            }}
          >
            <ExpoImage
              source={coverSource}
              placeholder={cover !== null && cover.blurhash !== "" ? { blurhash: cover.blurhash } : null}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              accessibilityLabel="Cover photo"
            />
          </View>
          <View style={{ paddingTop: space.md, paddingHorizontal: space.xs, gap: space.xxs }}>
            {/* `storyExcerpt` rather than the `slice(0, 140)` that used to
                be inlined here: the card and this preview have to cut the
                story at the same place, or the preview is a preview of
                something else. That function's own header comment has
                pointed at this file since it was extracted. */}
            <Text variant="storyExcerpt" color="textSecondary" numberOfLines={2} hangingPunctuation>
              “{storyExcerpt(draft.story)}”
            </Text>
            <Text variant="title" numberOfLines={1}>
              {draft.title || "Untitled"}
            </Text>
            {/* One caption line, as on the card — which spends it on
                place · distance. Neither exists yet (the postcode has not
                been resolved server-side, and there is no viewer to be a
                distance from), so it carries what the giver can still act
                on: where they said it is, and how many photos are going up.
                Issue #35: still no category — the giver never picked one, so
                surfacing the AI-assigned value would read as an unexplained
                surprise rather than a summary. */}
            <Text variant="caption" color="textTertiary" style={{ textTransform: "lowercase" }}>
              {COUNTRY_LABELS[draft.country]} {draft.postalCode} · {photoIds.length} photo{photoIds.length === 1 ? "" : "s"}
            </Text>
          </View>
        </Print>

        <AgeGateField value={dateOfBirth} onChangeText={setDateOfBirth} touched={dobTouched} onBlur={() => setDobTouched(true)} />

        <Turnstile ref={turnstileRef} onStatus={setTurnstileStatus} />

        {submitError !== null ? (
          <Text variant="body" color="dangerText">
            {submitError}
          </Text>
        ) : null}

        <View style={{ flexDirection: "row" }}>
          <Button
            label="Give it"
            loading={phase === "submitting"}
            disabled={phase === "submitting" || !turnstileReady || photoIds.length === 0 || !ageGateValid}
            onPress={() => void handleSubmit()}
          />
        </View>
      </Card>
    </Page>
  );
}
