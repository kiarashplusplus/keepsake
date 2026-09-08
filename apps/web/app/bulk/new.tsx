// "Give several items" — start a batch. Collects everything
// `CreateBatchInput` needs (name, country/postcode, optional shared story)
// and the giver's email — required, like the give flow's own email step,
// since a batch with no address behind it is dozens of listings nobody can
// be told about.
//
// The email is saved **here**, inline, by `POST /api/me/email` — the same
// call `app/mine/email.tsx` makes. It used to be a link to that screen at
// the bottom of the form, which meant the first thing this page asked of
// someone about to spend an evening photographing a house was to leave it.
// A batch lives on a device token; an email is the only way back to it from
// another browser, so it belongs in the form that starts the batch, beside
// the name it will be found under — not on a page they have to navigate to
// and then navigate back from.
//
// It is attached to the *owner*, not the batch (there is no email field on
// `CreateBatchInput` and shouldn't be), so it is saved as its own step —
// after the batch, because `POST /api/me/email` is one of the routes that
// 401s a token with no `owners` row yet, and on a fresh device
// `POST /api/bulk/batches` is what creates that row
// (`ownerAuth({ createIfMissing: true })`, see `routes/bulk.ts`).
//
// A refused address therefore leaves a batch already created — which is
// why `clientBatchKeyRef` below is minted once per visit rather than per
// press. `POST /api/bulk/batches` resolves a repeated client key to the
// same batch (its own `ON CONFLICT` re-select), so pressing "Start this
// batch" again after fixing or clearing the email retries the email
// against that same batch instead of stranding a second one.
import * as React from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { COUNTRIES, COUNTRY_LABELS, COUNTRY_POSTCODE_HINTS, normalizePostalCode, type Country, type PostalLookup } from "@keepsake/contracts/geo";
import { MailableEmailSchema, RESERVED_EMAIL_DOMAIN_MESSAGE } from "@keepsake/contracts/common";
import { STORY_MAX } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Input } from "@/ui/Input";
import { TextArea } from "@/ui/TextArea";
import { Chip } from "@/ui/Chip";
import { Button } from "@/ui/Button";
import { Turnstile, type TurnstileHandle, type TurnstileStatus } from "@/ui/Turnstile";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { createBatch } from "@/api/bulk";
import { getMe, setEmail } from "@/api/me";
import { ApiError } from "@/api/client";
import { lookupPostalCode } from "@/api/geo";
import { getOwnerToken } from "@/lib/ownerToken";
import { batchMetaFromSummary } from "@/features/bulk/batchStore";
import { getDefaultBulkStorageDriver, saveBatchMeta } from "@/features/bulk/storage";
import { describeBulkFailure, makeBulkClientId } from "@/features/bulk/useBulkWorkspace";

const NAME_MAX = 80;
const LOOKUP_DEBOUNCE_MS = 400;

/** Same shape as `app/give/details.tsx`'s `Resolved` — the last completed
 * postcode lookup, tagged with the exact (country, code) it answers, so a
 * stale response for an edited-away postcode is never displayed or
 * accepted. */
type Resolved = { country: Country; code: string; result: PostalLookup | null };

export default function NewBulkBatch(): React.ReactElement {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [country, setCountry] = React.useState<Country>("US");
  const [postalCode, setPostalCode] = React.useState("");
  const [sharedStory, setSharedStory] = React.useState("");
  const [email, setEmailInput] = React.useState("");
  const [emailTouched, setEmailTouched] = React.useState(false);
  /** The address already attached to this device's owner, once `getMe`
   * answers — `null` while unknown or when there is none. Kept apart from
   * `email` (what is in the field) so re-submitting an unchanged address
   * doesn't spend a Turnstile token or send a second verification mail. */
  const [savedEmail, setSavedEmail] = React.useState<string | null>(null);
  const [emailVerified, setEmailVerified] = React.useState(false);
  const [turnstileStatus, setTurnstileStatus] = React.useState<TurnstileStatus>({ status: "pending" });
  const turnstileRef = React.useRef<TurnstileHandle>(null);
  const [resolved, setResolved] = React.useState<Resolved | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  /** One key for this visit, not one per press — see this file's header on
   * why a retry has to resolve to the batch the last press created. */
  const clientBatchKeyRef = React.useRef<string | null>(null);

  // Only asked for when this device already has an owner identity — `getMe`
  // is `owner: true`, and `src/api/client.ts` mints a token for any call
  // that says so. Minting one just because someone opened this form would
  // hand out an identity to a visitor who has given nothing, which is
  // exactly what `lib/ownerToken.ts`'s header forbids.
  React.useEffect(() => {
    if (getOwnerToken() === null) return;
    getMe()
      .then((me) => {
        if (me.email === undefined) return;
        setSavedEmail(me.email);
        setEmailVerified(me.email_verified === true);
        // Functional update: never clobber something already typed.
        setEmailInput((current) => (current === "" ? (me.email ?? "") : current));
      })
      .catch(() => {
        // A failed `getMe` says nothing about whether the address the giver
        // is about to type will save — leave the field empty and let the
        // save itself report a real problem.
      });
  }, []);

  const normalized = normalizePostalCode(country, postalCode);

  React.useEffect(() => {
    if (normalized === null) return undefined;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      lookupPostalCode({ country, code: normalized, signal: controller.signal })
        .then((result) => setResolved({ country, code: normalized, result }))
        .catch(() => {
          if (!controller.signal.aborted) setResolved({ country, code: normalized, result: null });
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [country, postalCode, normalized]);

  const isResolvedForCurrent = normalized !== null && resolved !== null && resolved.country === country && resolved.code === normalized;
  const lookupResult = isResolvedForCurrent ? resolved.result : null;
  const postcodeHelper =
    normalized === null || !isResolvedForCurrent
      ? "Only the town it resolves to ever appears in this batch's listings — never the postcode itself."
      : lookupResult !== null
        ? `${lookupResult.place_name}${lookupResult.admin1 !== null ? `, ${lookupResult.admin1}` : ""}`
        : "We don't know that postcode yet.";

  const trimmedName = name.trim();
  const nameValid = trimmedName.length > 0 && trimmedName.length <= NAME_MAX;
  const nameError = nameTouched && !nameValid ? "A name for this batch, up to 80 characters." : undefined;

  const trimmedEmail = email.trim();
  const emailValidation = MailableEmailSchema.safeParse(trimmedEmail);
  // Required, where it used to be optional. An estate batch is dozens of
  // listings behind one device token: without an address, every ask on every
  // one of them waits for the giver to reopen this browser, and clearing the
  // browser takes the whole batch with it. `POST /api/bulk/batches/:id/submit`
  // enforces the same thing at the moment a batch becomes live listings, so
  // asking here is the polite half of a rule that holds either way.
  const emailValid = emailValidation.success;
  const emailNeedsSaving = trimmedEmail !== "" && trimmedEmail !== savedEmail;
  const emailError =
    emailTouched && !emailValid
      ? trimmedEmail === ""
        ? "We need an email to tell you when someone asks."
        : emailValidation.success === false && emailValidation.error.issues[0]?.message === RESERVED_EMAIL_DOMAIN_MESSAGE
          ? RESERVED_EMAIL_DOMAIN_MESSAGE
          : "That doesn't look like an email address."
      : undefined;

  // `POST /api/me/email` is Turnstile-protected, so a pending challenge
  // blocks the button only when there is actually an address to save — never
  // for a giver whose address is already on their owner row.
  const turnstileReady = turnstileStatus.status === "ready" || turnstileStatus.status === "unconfigured";
  const turnstileToken = turnstileStatus.status === "ready" ? turnstileStatus.token : "";

  const canSubmit =
    nameValid && isResolvedForCurrent && lookupResult !== null && emailValid && (!emailNeedsSaving || turnstileReady) && !submitting;

  const emailHelper = emailNeedsSaving
    ? "We'll send one note to verify it. Nothing else."
    : savedEmail !== null && trimmedEmail === savedEmail
      ? emailVerified
        ? "Verified — this batch is reachable from any browser."
        : "Saved. Check your inbox to verify it."
      : "How you hear that someone asked, and the only way back to this batch from another browser.";

  async function handleCreate(): Promise<void> {
    setNameTouched(true);
    setEmailTouched(true);
    if (!canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);

    const clientBatchKey = clientBatchKeyRef.current ?? makeBulkClientId("batch");
    clientBatchKeyRef.current = clientBatchKey;

    const result = await createBatch({
      client_batch_key: clientBatchKey,
      name: trimmedName,
      country,
      postal_code: postalCode,
      ...(sharedStory.trim() !== "" ? { shared_story: sharedStory.trim() } : {}),
    });

    if (!result.ok) {
      setSubmitError(describeBulkFailure(result.error));
      setSubmitting(false);
      return;
    }

    const meta = batchMetaFromSummary(clientBatchKey, result.data);
    await saveBatchMeta(getDefaultBulkStorageDriver(), meta);

    if (emailNeedsSaving) {
      try {
        const me = await setEmail({ email: trimmedEmail }, { turnstileToken });
        setSavedEmail(me.email ?? trimmedEmail);
        setEmailVerified(me.email_verified === true);
      } catch (err) {
        // A Turnstile token is single-use and was just spent, so force a
        // fresh one before the next attempt — the same reason
        // `app/mine/email.tsx` resets its widget after every send. The
        // batch above is saved and its key is held, so pressing again
        // retries only the email.
        turnstileRef.current?.reset();
        setTurnstileStatus({ status: "pending" });
        setSubmitError(
          err instanceof ApiError
            ? `${err.message} Your batch is saved — fix the address or clear it, then press again.`
            : "That email didn't go through. Your batch is saved — try again, or clear the address to carry on without one.",
        );
        setSubmitting(false);
        return;
      }
    }

    router.replace({ pathname: "/bulk/[batchKey]/photos", params: { batchKey: clientBatchKey } });
  }

  return (
    <Page variant="prose">
      <Card style={{ gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow tick>Give several items</Eyebrow>
          <Text variant="displayLg">Start clearing a house.</Text>
          <Text variant="bodyLg" color="textSecondary">
            Prepare as many keepsakes as you like, across as many evenings as it takes, then publish the ready ones together.
          </Text>
        </View>

        <View style={{ gap: space.xs }}>
          <Input
            label="Batch name"
            value={name}
            onChangeText={setName}
            onBlur={() => setNameTouched(true)}
            maxLength={NAME_MAX}
            error={nameError}
            placeholder="Mum's house — September"
          />
          <Text variant="caption" color="textTertiary">
            {"Private — only you ever see this name. It's how you'll find this batch again in Mine."}
          </Text>
        </View>

        <View style={{ gap: space.xs }}>
          <Input
            label="Email"
            value={email}
            onChangeText={setEmailInput}
            onBlur={() => setEmailTouched(true)}
            error={emailError}
            helper={emailHelper}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="you@example.com"
          />
          <Text variant="caption" color="textTertiary">
            {"This can take several sittings over a number of days. An email is how you pick this batch up again from another browser — and how you hear when someone asks for something."}
          </Text>
          {emailNeedsSaving ? <Turnstile ref={turnstileRef} onStatus={setTurnstileStatus} /> : null}
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="eyebrow" color="accent2Text">
            Country
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {COUNTRIES.map((c) => (
              <Chip key={c} label={COUNTRY_LABELS[c]} selected={country === c} onPress={() => setCountry(c)} />
            ))}
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <Input
            label="Postcode"
            value={postalCode}
            onChangeText={setPostalCode}
            placeholder={COUNTRY_POSTCODE_HINTS[country]}
            helper={postcodeHelper}
            style={{ maxWidth: 240 }}
          />
        </View>

        <View style={{ gap: space.xs }}>
          <TextArea
            label="Shared household story (optional)"
            value={sharedStory}
            onChangeText={setSharedStory}
            maxLength={STORY_MAX}
            minHeight={100}
            placeholder="Everything here belonged to my grandmother, who lived in this house for sixty years."
          />
          <Text variant="caption" color="textTertiary">
            {'Public — you can offer to add this to individual items\' stories later ("Apply to selected"), but it is never shown on its own.'}
          </Text>
        </View>

        {submitError !== null ? (
          <Text variant="body" color="dangerText">
            {submitError}
          </Text>
        ) : null}

        <View style={{ flexDirection: "row" }}>
          <Button label="Start this batch" loading={submitting} disabled={!canSubmit} onPress={() => void handleCreate()} />
        </View>
      </Card>
    </Page>
  );
}
