/**
 * One line out of a moderation event's `flags` (#363). The API stores
 * whatever the pipeline had to hand — for an image pass, the vision model's
 * whole scorecard (`{"variant":"thumb","is_physical_object":true,"nsfw":0,
 * "violence":0,…,"notes":""}`); for a text hit, the array of reason codes;
 * for a re-moderation downgrade, `{downgraded_from, prior_takedown,
 * prior_version}` — and `QueueItemCard` used to print it as one
 * `JSON.stringify` string, which at 390px wrapped mid-token into four lines
 * per event, most of them zeros. This keeps what a moderator actually reads:
 * the scores that are not zero, the checks that are not true, the strings
 * that are not empty. The full JSON is still one tap away behind the card's
 * "Show raw" disclosure.
 *
 * `flags` is `z.unknown()` on the contract on purpose (the shape is the
 * pipeline's, not the queue's), so this is written against the *kinds* of
 * value rather than any key list — a new score the model starts returning
 * shows up here without a web change.
 */
export type FlagSummary = {
  /** The entries worth a glance, in the order the object listed them. */
  raised: string[];
  /** Whether there was anything to summarise at all — `false` for `null`,
   * an empty object or an empty array, when the row should say nothing
   * rather than "nothing raised". */
  present: boolean;
};

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

export function summarizeFlags(flags: unknown): FlagSummary {
  if (flags === null || flags === undefined) return { raised: [], present: false };

  if (Array.isArray(flags)) {
    return { raised: flags.map(formatValue), present: flags.length > 0 };
  }

  if (typeof flags !== "object") {
    return { raised: [formatValue(flags)], present: true };
  }

  const entries = Object.entries(flags as Record<string, unknown>);
  const raised: string[] = [];
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    // A zero score is the model saying "nothing here"; a true check is the
    // same ("is a physical object: yes"); an empty string is a blank notes
    // field. All three are the absence of a finding.
    if (typeof value === "number" && value === 0) continue;
    if (typeof value === "boolean" && value) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    raised.push(`${key} ${formatValue(value)}`);
  }
  return { raised, present: entries.length > 0 };
}

/** The line `QueueItemCard` prints, or `null` when there is nothing to print. */
export function formatFlagsLine(flags: unknown): string | null {
  const summary = summarizeFlags(flags);
  if (!summary.present) return null;
  return summary.raised.length === 0 ? "nothing raised" : summary.raised.join(" · ");
}
