// "Give several items" — start a batch. Collects everything
// `CreateBatchInput` needs (name, country/postcode, optional shared story)
// plus two things the wire contract deliberately doesn't carry: the
// admission grant id (an operator hands this to a giver out of band — see
// `src/lib/bulkGrant.ts`) and an optional private pickup-deadline reminder
// (`src/features/bulk/pickupDeadline.ts`, local-only, never a promise the
// product makes to anyone).
import * as React from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { COUNTRIES, COUNTRY_LABELS, COUNTRY_POSTCODE_HINTS, normalizePostalCode, type Country, type PostalLookup } from "@keepsake/contracts/geo";
import { STORY_MAX } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Input } from "@/ui/Input";
import { TextArea } from "@/ui/TextArea";
import { Chip } from "@/ui/Chip";
import { Button } from "@/ui/Button";
import { DateField } from "@/ui/DateField";
import { Page } from "@/ui/Page";
import { Card } from "@/ui/Surface";
import { createBatch } from "@/api/bulk";
import { lookupPostalCode } from "@/api/geo";
import { batchMetaFromSummary } from "@/features/bulk/batchStore";
import { getDefaultBulkStorageDriver, saveBatchMeta } from "@/features/bulk/storage";
import { describeBulkFailure, makeBulkClientId } from "@/features/bulk/useBulkWorkspace";
import { getStoredGrantId, setStoredGrantId } from "@/lib/bulkGrant";
import { setPickupDeadline } from "@/features/bulk/pickupDeadline";

const NAME_MAX = 80;
const LOOKUP_DEBOUNCE_MS = 400;

/** Same shape as `app/give/details.tsx`'s `Resolved` — the last completed
 * postcode lookup, tagged with the exact (country, code) it answers, so a
 * stale response for an edited-away postcode is never displayed or
 * accepted. */
type Resolved = { country: Country; code: string; result: PostalLookup | null };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function NewBulkBatch(): React.ReactElement {
  const router = useRouter();
  const params = useLocalSearchParams<{ grant?: string }>();
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [country, setCountry] = React.useState<Country>("US");
  const [postalCode, setPostalCode] = React.useState("");
  const [sharedStory, setSharedStory] = React.useState("");
  const [deadline, setDeadline] = React.useState("");
  const [grantId, setGrantId] = React.useState(() => params.grant ?? getStoredGrantId());
  const [grantTouched, setGrantTouched] = React.useState(false);
  const [resolved, setResolved] = React.useState<Resolved | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // A `?grant=` link (an operator emailing a fresh code) always wins over
  // whatever was stored or typed before. Adjusting `grantId` from a changed
  // prop like this — during render, guarded by comparing against the last
  // value seen, rather than inside a `useEffect` — is the pattern React's
  // own docs recommend for "reset/update some state when a prop changes"
  // (react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // the previous effect-based version tripped `eslint-plugin-react-hooks`'s
  // "setState synchronously within an effect" rule, because this was never
  // a synchronization with anything external — that part is the storage
  // write below, which is a real effect.
  const [lastGrantParam, setLastGrantParam] = React.useState(params.grant);
  if (params.grant !== lastGrantParam) {
    setLastGrantParam(params.grant);
    if (params.grant !== undefined && params.grant.trim() !== "") setGrantId(params.grant);
  }

  // Remembered immediately (not just at submit, in `handleCreate` below) so
  // leaving and returning to this screen before starting a batch doesn't
  // lose a fresh `?grant=` link.
  React.useEffect(() => {
    if (params.grant === undefined || params.grant.trim() === "") return;
    setStoredGrantId(params.grant);
  }, [params.grant]);

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
  const grantValid = grantId.trim() !== "";
  const grantError = grantTouched && !grantValid ? "Ask whoever set up your pilot for an admission code." : undefined;

  const canSubmit = nameValid && isResolvedForCurrent && lookupResult !== null && grantValid && !submitting;

  async function handleCreate(): Promise<void> {
    setNameTouched(true);
    setGrantTouched(true);
    if (!canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);
    setStoredGrantId(grantId);

    const clientBatchKey = makeBulkClientId("batch");
    const result = await createBatch(
      {
        client_batch_key: clientBatchKey,
        name: trimmedName,
        country,
        postal_code: postalCode,
        ...(sharedStory.trim() !== "" ? { shared_story: sharedStory.trim() } : {}),
      },
      { grantId: grantId.trim() },
    );

    if (!result.ok) {
      setSubmitError(describeBulkFailure(result.error));
      setSubmitting(false);
      return;
    }

    const meta = batchMetaFromSummary(clientBatchKey, result.data);
    await saveBatchMeta(getDefaultBulkStorageDriver(), meta);
    if (deadline.trim() !== "") setPickupDeadline(clientBatchKey, deadline.trim());

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

        <View style={{ gap: space.xs }}>
          <DateField label="Pickup deadline (optional)" value={deadline} onChangeText={setDeadline} min={todayIso()} helper="Private — a reminder for you only. Never shown to anyone, and never promises items go live by this date." />
        </View>

        <View style={{ gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: "transparent" }}>
          <Input
            label="Admission code"
            value={grantId}
            onChangeText={setGrantId}
            onBlur={() => setGrantTouched(true)}
            error={grantError}
            placeholder="Given to you by whoever set up your pilot"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ maxWidth: 320 }}
          />
          <Text variant="caption" color="textTertiary">
            {"This estate upload needs an admission code from the pilot's operator — it bounds how many items and photos you can add, not who you are."}
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

        <View
          style={{
            paddingTop: space.md,
            borderTopWidth: 1,
            borderTopColor: "transparent",
            gap: space.xs,
          }}
        >
          <Text variant="body" color="textSecondary">
            This can take several sittings over a number of days. Add a verified email so you can find this batch again, even from a different browser.
          </Text>
          <Button label="Add your email" variant="link" onPress={() => router.push("/mine/email")} />
        </View>
      </Card>
    </Page>
  );
}
