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
import { getOwnerToken } from "@/lib/ownerToken";
import { config } from "@/lib/config";
import { shareListing } from "@/lib/share";
import { useToast } from "@/ui/Toast";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

type Phase = "review" | "submitting" | "polling";

function coverImageSource(photo: ReturnType<typeof coverPhoto>): { uri: string; headers?: Record<string, string> } | null {
  if (photo === null || photo.id === null) return null;
  if (photo.objectUrl !== null) return { uri: photo.objectUrl };
  const origin = config.siteUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const token = getOwnerToken();
  return {
    uri: `${origin}/i/${photo.id}/thumb`,
    ...(token !== null ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

export default function GiveReview(): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const colors = useColors();
  const { draft, dispatch } = useGiveDraft();
  const [phase, setPhase] = React.useState<Phase>("review");
  const [turnstileStatus, setTurnstileStatus] = React.useState<TurnstileStatus>({ status: "pending" });
  const turnstileRef = React.useRef<TurnstileHandle>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
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
    const result = await shareListing({ id: listing.id, title: listing.title });
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

        {/* The listing as it will lie on the table: an actual print. */}
        <Print tiltDeg={-1.5} style={{ alignSelf: "stretch", padding: space.sm }}>
          <View style={{ paddingTop: space.xl, paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm }}>
            {/* Source ladder: the local object URL from this session's
                upload; else the owner-token-authed thumb route (covers a
                reload or a `?edit=` prefill, where the object URL is
                always null); else the blurhash alone. */}
            <View style={{ width: 96, height: 96, alignSelf: "flex-start", overflow: "hidden", backgroundColor: colors.tableEdge }}>
              <ExpoImage
                source={coverImageSource(cover)}
                placeholder={cover !== null && cover.blurhash !== "" ? { blurhash: cover.blurhash } : null}
                style={{ width: "100%", height: "100%" }}
                contentFit="cover"
                accessibilityLabel="Cover photo"
              />
            </View>
            <Text variant="storyExcerpt" color="textSecondary" hangingPunctuation>
              “{draft.story.slice(0, 140)}
              {draft.story.length > 140 ? "…" : ""}”
            </Text>
            <Text variant="title">{draft.title || "Untitled"}</Text>
            <View style={{ paddingTop: space.sm, gap: space.xxs }}>
              {/* Issue #35: no category shown here anymore — the giver
                  never picked one, so surfacing the AI-assigned value would
                  read as an unexplained surprise rather than a summary. */}
              <Text variant="caption" color="textTertiary" style={{ textTransform: "lowercase" }}>
                {COUNTRY_LABELS[draft.country]} {draft.postalCode}
              </Text>
              <Text variant="caption" color="textTertiary" style={{ textTransform: "lowercase" }}>
                {photoIds.length} photo{photoIds.length === 1 ? "" : "s"}
              </Text>
            </View>
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
