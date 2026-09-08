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
// react-test-renderer.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
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
  // Issue #308 changed that wording: the pre-submit note gained "or tell
  // someone else the time and place" as an alternative to bringing a friend,
  // and the post-submit note gained permission to back out — both already on
  // `terms.html`'s "Meeting up safely" list, neither previously in the
  // product. These constants moved with the copy; if they drift from
  // `RequestSheet.tsx` again, that is the bug, not this test.
  //
  // Asserted through `UNSAFE_getAllByType`, which reads the composite
  // element's authored props before react-native-web's host translation, for
  // the same reason `test/ui/Button.test.tsx` explains at length. A
  // whole-tree string match is not usable here: the form is full of
  // legitimate 12px mono — every field label, the character counter, the
  // age-gate hint — so "no caption anywhere" would fail on copy that is
  // correctly set as small print.
  const FORM_COPY =
    "A note before you send this: if you two meet up, pick a public spot, bring a " +
    "friend if you can — or tell someone else the time and place — and keep talking " +
    "here in Keepsake rather than trading numbers early. A porch handoff works too, " +
    "if you'd both rather skip meeting in person.";

  const SENT_COPY =
    "If you're chosen: meet somewhere public and well-lit, bring a friend or tell " +
    "someone the plan, and keep working out the details here in Keepsake rather than " +
    "switching to text. Leaving it on a porch instead of meeting face to face is always " +
    "fine too — just say so. And if anything feels off, you can back out — that's worth " +
    "more than any obligation you feel to a stranger you agreed to meet.";

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
});
