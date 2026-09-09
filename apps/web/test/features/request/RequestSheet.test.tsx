import * as React from "react";
import { TextInput } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { RequestSheet } from "@/features/request/RequestSheet";
import { SafetyNote } from "@/ui/SafetyNote";
import { createRequest } from "@/api/requests";
import { ApiError } from "@/api/client";

jest.mock("@/api/requests", () => ({ createRequest: jest.fn() }));

// See test/app/item/[id].test.tsx's header comment on why `Sheet` is mocked
// down to "render children" — RN `Modal`'s portal isn't supported by
// react-test-renderer. `footer` (issue #373 finding 1) renders in its own
// `testID`-tagged wrapper, sibling to one around `children`, so a test here
// can tell which slot a given element came from — `test/ui/Sheet.test.tsx`
// owns proving `Sheet` itself pins that slot on screen; this file only needs
// to prove `RequestSheet` hands the right things to the right slot.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  const { View: RNView } = jest.requireActual("react-native");
  return {
    Sheet: ({ visible, children, footer }: { visible: boolean; children: React.ReactNode; footer?: React.ReactNode }) =>
      visible
        ? ReactActual.createElement(
            ReactActual.Fragment,
            null,
            ReactActual.createElement(RNView, { testID: "sheet-body-slot" }, children),
            ReactActual.createElement(RNView, { testID: "sheet-footer-slot" }, footer),
          )
        : null,
  };
});

// Each field change gets its own `act`, rather than batching several
// `fireEvent` calls before a single `press`: batched synchronous updates can
// still be mid-flight when `press` reads the *previous* render's closure
// over `note`/`email`, so `handleSubmit` would validate against stale
// (empty) values and bail before ever calling `createRequest`.
async function fillAndSubmit(
  instance: ReturnType<typeof render>,
  note: string,
  email: string,
): Promise<void> {
  // Note, email, phone (optional) — in that render order (see
  // RequestSheet.tsx). Phone is skipped here; every test leaves it blank.
  const [noteField, emailField] = instance.UNSAFE_getAllByType(TextInput);
  // Date of birth is addressed by its label, not by position: since #133 it
  // is a DOM `<input type="date">` (`ui/DateField.web.tsx`), not a
  // `TextInput` at all, so an index into the TextInputs would silently pick
  // up the phone field instead of failing.
  const dobField = instance.getByLabelText("Date of birth");
  if (noteField === undefined || emailField === undefined) {
    throw new Error("Expected note and email fields");
  }

  await act(async () => {
    fireEvent.changeText(noteField, note);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.changeText(emailField, email);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.changeText(dobField, "1990-01-01");
    await Promise.resolve();
  });

  const sendButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Send" });
  await act(async () => {
    fireEvent.press(sendButton);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RequestSheet", () => {
  beforeEach(() => {
    jest.mocked(createRequest).mockReset();
  });

  it("shows a validation message and does not submit when the note is too short", async () => {
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "too short", "person@keepsake.ing");

    expect(jest.mocked(createRequest)).not.toHaveBeenCalled();
    expect(JSON.stringify(instance.toJSON())).toContain("At least 10 characters");
  });

  it("shows the reserved-domain message inline and does not submit", async () => {
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(
      instance,
      "Tell them why it should be mine, please and thank you.",
      "me@example.com",
    );

    expect(jest.mocked(createRequest)).not.toHaveBeenCalled();
    expect(JSON.stringify(instance.toJSON())).toContain("That address can't receive mail — try another.");
  });

  // Issue #188: the success state names the confirmation step rather than
  // claiming the note was delivered. The assertion is on the "check your
  // email" half specifically — that is the sentence the flow now depends on
  // someone reading, and a copy edit that drops it would leave people
  // believing an unconfirmed request is on its way.
  it("submits and asks the requester to confirm by email on success", async () => {
    jest.mocked(createRequest).mockResolvedValue({ id: "req-1", created_at: Date.now() });
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    expect(jest.mocked(createRequest)).toHaveBeenCalledTimes(1);
    const tree = JSON.stringify(instance.toJSON());
    expect(tree).toContain("We've emailed you to check it was really you.");
    expect(tree).not.toContain("Sent. The giver will choose in their own time.");
  });

  it("shows the 409 conflict message inline instead of a generic error", async () => {
    jest.mocked(createRequest).mockRejectedValue(new ApiError("conflict", "Already asked", 409));
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    expect(JSON.stringify(instance.toJSON())).toContain("You've already asked for this one.");
  });

  it("shows the 410 gone message inline instead of a generic error", async () => {
    jest.mocked(createRequest).mockRejectedValue(new ApiError("gone", "Just given away", 410));
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    expect(JSON.stringify(instance.toJSON())).toContain("This keepsake was just given to someone else.");
  });

  // Issue #224 item 2. Both safety paragraphs were `caption`/`textTertiary` —
  // 12px CourierPrime in the faintest colour the palette has — which set the
  // most consequential copy in the product like something people are meant to
  // skip. `test/ui/SafetyNote.test.tsx` owns the typographic and contrast
  // assertions; these two own the two things only this file can see: that the
  // sheet reaches for that component on BOTH phases, and exactly what wording
  // it hands over.
  //
  // Issue #308 had added "or tell someone else the time and place" to the
  // pre-submit note and permission to back out to the post-submit note, both
  // already on `terms.html`'s "Meeting up safely" list.
  //
  // Issue #373 finding 9: the two notes had grown to say much the same thing
  // at similar length, back to back — a stranger read the whole safety case
  // once before sending and once again immediately after. `terms.html`'s
  // list has five distinct points; before this fix, four of them (all but
  // the back-out permission #308 added) appeared in BOTH notes, word for
  // word. Each point now appears exactly once, homed by which moment it
  // matters for:
  //
  //   1. Meet somewhere public and well-lit         -> SENT_COPY only
  //   2. Bring a friend, or tell someone the plan    -> SENT_COPY only
  //   3. Keep talking in Keepsake, not text/numbers  -> FORM_COPY only
  //   4. A porch handoff / no in-person meetup is OK -> FORM_COPY only
  //   5. You can back out if anything feels off      -> SENT_COPY only (#308)
  //
  // FORM_COPY keeps what's decision-relevant before sending (how you'll keep
  // talking, and that meeting in person isn't required at all). SENT_COPY
  // keeps what matters once being chosen is a live possibility: the meetup
  // itself, and the standing permission to back out of it. Nothing from
  // `terms.html`'s list was dropped — see the point-by-point coverage test
  // below, which fails if any of the five goes missing from both notes, not
  // just if the exact sentence changes.
  //
  // These constants moved with the copy; if they drift from `RequestSheet.tsx`
  // again, that is the bug, not this test.
  //
  // Asserted through `UNSAFE_getAllByType`, which reads the composite
  // element's authored props before react-native-web's host translation, for
  // the same reason `test/ui/Button.test.tsx` explains at length. A
  // whole-tree string match is not usable here: the form is full of
  // legitimate 12px mono — every field label, the character counter, the
  // age-gate hint — so "no caption anywhere" would fail on copy that is
  // correctly set as small print.
  const FORM_COPY =
    "A note before you send this: if you're chosen, keep working out the details here " +
    "in Keepsake rather than trading numbers early — and if you'd both rather skip " +
    "meeting in person, a porch handoff works just as well.";

  const SENT_COPY =
    "If you're chosen: meet somewhere public and well-lit, and bring a friend or tell " +
    "someone the plan. And if anything feels off, you can back out — that's worth more " +
    "than any obligation you feel to a stranger you agreed to meet.";

  it("sets the form's safety guidance as a note, not as small print", () => {
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    const notes = instance.UNSAFE_getAllByType(SafetyNote);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.props.children).toBe(FORM_COPY);
  });

  it("sets the sent state's safety guidance as a note too", async () => {
    jest.mocked(createRequest).mockResolvedValue({ id: "req-1", created_at: Date.now() });
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    const notes = instance.UNSAFE_getAllByType(SafetyNote);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.props.children).toBe(SENT_COPY);
  });

  // Issue #373 finding 9: pins the five ideas themselves, not just the exact
  // sentences above — this is the test that fails if a fix "shortens" one of
  // the notes by quietly dropping a point from `terms.html`'s list rather
  // than moving it to its new home. Each phrase is checked for appearing in
  // exactly the note this fix assigned it to, and NOT in the other note —
  // that second half is what would have caught the duplication finding 9
  // reports in the first place.
  it("keeps every terms.html safety point exactly once, in its assigned note", async () => {
    jest.mocked(createRequest).mockResolvedValue({ id: "req-1", created_at: Date.now() });

    // Form phase: ideas 3 (stay in Keepsake) and 4 (porch handoff is fine)
    // live here; ideas 1, 2 and 5 (meetup specifics and backing out) do not
    // belong yet — nobody has been chosen.
    const formInstance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);
    const formCopy = String(formInstance.UNSAFE_getAllByType(SafetyNote)[0]?.props.children);
    expect(formCopy).toContain("here in Keepsake rather than trading numbers early");
    expect(formCopy).toContain("porch handoff");
    expect(formCopy).not.toContain("public and well-lit");
    expect(formCopy).not.toContain("bring a friend");
    expect(formCopy).not.toContain("back out");

    // Sent phase: ideas 1 (public/well-lit), 2 (bring a friend/tell someone)
    // and 5 (back out) live here; ideas 3 and 4 don't repeat — the form note
    // already said them.
    const sentInstance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-2" />);
    await fillAndSubmit(sentInstance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");
    const sentCopy = String(sentInstance.UNSAFE_getAllByType(SafetyNote)[0]?.props.children);
    expect(sentCopy).toContain("public and well-lit");
    expect(sentCopy).toContain("bring a friend");
    expect(sentCopy).toContain("back out");
    expect(sentCopy).not.toContain("here in Keepsake rather than trading numbers early");
    expect(sentCopy).not.toContain("porch handoff");
  });

  // Issue #373 finding 1's second half: `item-request-sent.jpg` showed DONE
  // sitting on the very bottom edge of the 390×844 baseline — the same
  // below-the-fold shape as SEND, caused the same way by the same sheet's
  // safety copy, just one phase later. Checked against which mocked `Sheet`
  // slot the button landed in (see the mock's header comment above) rather
  // than a whole-tree string match, which can't distinguish "in the footer"
  // from "in the scrolling body".
  it("puts the sent phase's Done button in the footer, not the scrolling body", async () => {
    jest.mocked(createRequest).mockResolvedValue({ id: "req-1", created_at: Date.now() });
    const instance = render(<RequestSheet visible onClose={jest.fn()} listingId="listing-1" />);

    await fillAndSubmit(instance, "Tell them why it should be mine, please and thank you.", "person@keepsake.ing");

    const footerSlot = instance.UNSAFE_getByProps({ testID: "sheet-footer-slot" });
    const bodySlot = instance.UNSAFE_getByProps({ testID: "sheet-body-slot" });
    // `Button` fans one `accessibilityLabel` out across its own composite
    // layers (the styled wrapper, the underlying `Pressable`, ...), so the
    // count that matters is "present at all" in the footer and "absent
    // entirely" from the body — not an exact match on how many layers carry it.
    expect(footerSlot.findAllByProps({ accessibilityLabel: "Done" }).length).toBeGreaterThan(0);
    expect(bodySlot.findAllByProps({ accessibilityLabel: "Done" })).toHaveLength(0);
  });
});
