// Give flow — step 5 of 5: review, submit, and the "reviewing" state
// (breathing seal -> live/rejected/held/timeout). Submitting when
// `draft.listingId` is already set (a prior rejected attempt, or an
// `/give?edit=<id>` prefill) PATCHes that listing instead of creating a new
// one, which is what makes the rejected-state "Edit" button below actually
// resubmit the same listing rather than spawning a duplicate.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import type { CreateListingInput, OwnerListing as OwnerListingT } from "@keepsake/contracts/listing";
import { CATEGORY_LABELS, MODERATION_REASONS } from "@keepsake/contracts/listing";
import { COUNTRY_LABELS } from "@keepsake/contracts/geo";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Print } from "@/ui/Print";
import { Card } from "@/ui/Surface";
import { Stamp, type StampState } from "@/ui/Stamp";
import { Turnstile } from "@/ui/Turnstile";
import { Page } from "@/ui/Page";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { makeClientId } from "@/features/give/giveDraft";
import { editStepForReason, resolveReviewOutcome } from "@/features/give/reviewOutcome";
import { createListing, updateListing } from "@/api/listings";
import { getMyListing } from "@/api/me";
import { ApiError } from "@/api/client";
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
  const { draft, dispatch } = useGiveDraft();
  const [phase, setPhase] = React.useState<Phase>("review");
  const [turnstileToken, setTurnstileToken] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [listing, setListing] = React.useState<OwnerListingT | null>(null);
  const [timedOut, setTimedOut] = React.useState(false);
  const idempotencyKeyRef = React.useRef(makeClientId());

  const photoIds = draft.photos.filter((photo) => photo.status === "done" && photo.id !== null).map((photo) => photo.id as string);

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
    if (listing.status === "approved") track(AnalyticsEvents.GiveLive);
    if (listing.status === "rejected") track(AnalyticsEvents.GiveRejected);
  }, [listing]);

  async function handleSubmit(): Promise<void> {
    if (draft.category === null || photoIds.length === 0) return;
    setSubmitError(null);
    setPhase("submitting");

    const input: CreateListingInput = {
      title: draft.title,
      story: draft.story,
      category: draft.category,
      country: draft.country,
      postal_code: draft.postalCode,
      photo_ids: photoIds,
      ...(draft.email.trim() !== "" ? { email: draft.email.trim() } : {}),
    };

    try {
      const result =
        draft.listingId !== null
          ? await updateListing(draft.listingId, input)
          : await createListing(input, { turnstileToken: turnstileToken ?? "", idempotencyKey: idempotencyKeyRef.current });

      dispatch({ type: "set_listing_id", listingId: result.id });
      setListing(result);
      setPhase("polling");
      track(AnalyticsEvents.GiveSubmitted);
    } catch (error) {
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
            <Text variant="storyExcerpt" color="textSecondary" hangingPunctuation>
              “{draft.story.slice(0, 140)}
              {draft.story.length > 140 ? "…" : ""}”
            </Text>
            <Text variant="title">{draft.title || "Untitled"}</Text>
            <View style={{ paddingTop: space.sm, gap: space.xxs }}>
              <Text variant="caption" color="textTertiary" style={{ textTransform: "lowercase" }}>
                {draft.category !== null ? CATEGORY_LABELS[draft.category] : ""} · {COUNTRY_LABELS[draft.country]} {draft.postalCode}
              </Text>
              <Text variant="caption" color="textTertiary" style={{ textTransform: "lowercase" }}>
                {photoIds.length} photo{photoIds.length === 1 ? "" : "s"}
              </Text>
            </View>
          </View>
        </Print>

        <Turnstile onToken={setTurnstileToken} />

        {submitError !== null ? (
          <Text variant="body" color="dangerText">
            {submitError}
          </Text>
        ) : null}

        <View style={{ flexDirection: "row" }}>
          <Button
            label="Give it"
            loading={phase === "submitting"}
            disabled={phase === "submitting" || turnstileToken === null || photoIds.length === 0}
            onPress={() => void handleSubmit()}
          />
        </View>
      </Card>
    </Page>
  );
}
