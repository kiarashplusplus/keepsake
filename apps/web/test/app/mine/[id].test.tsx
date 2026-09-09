import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ToastProvider } from "@/ui/Toast";
import { chooseRequest, getMyListing, type OwnerListingDetail } from "@/api/me";
import { deleteListing, setListingCategory, withdrawListing } from "@/api/listings";
import { MODERATION_REASONS } from "@keepsake/contracts/listing";
import { ApiError } from "@/api/client";
import MineDetail from "../../../app/mine/[id]";

// One router object for the whole file, rather than a fresh `jest.fn()` per
// `useRouter()` call: the delete regression below (issue #172) asserts on
// whether `replace` was called at all, which a per-call mock makes
// unobservable. The `mock` prefix is what lets `babel-plugin-jest-hoist`
// allow the reference from inside the hoisted factory.
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ id: "listing-1" }),
    useRouter: () => mockRouter,
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/me", () => ({ getMyListing: jest.fn(), chooseRequest: jest.fn() }));

jest.mock("@/api/listings", () => ({
  deleteListing: jest.fn(),
  markGiven: jest.fn(),
  relistListing: jest.fn(),
  setListingCategory: jest.fn(),
  withdrawListing: jest.fn(),
}));

// See test/app/item/[id].test.tsx's header comment on why `Sheet` (used by
// both the delete-confirm and Handoff sheets here) is mocked down to "render
// children when visible".
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
  };
});

function baseListing() {
  return {
    id: "listing-1",
    title: "A hand-thrown mug",
    story: "My grandmother made this every morning for forty years, and I finally have to let it go.",
    category: "home_kitchen" as const,
    place_name: "Somerville",
    admin1: "MA",
    country: "US" as const,
    photos: [],
    aspects: [],
    published_at: 0,
  };
}

function detailWithOpenRequest(): OwnerListingDetail {
  return {
    ...baseListing(),
    status: "approved",
    postal_code: "02144",
    moderation_reason: null,
    request_count: 1,
    chosen_request_id: null,
    version: 1,
    created_at: 0,
    updated_at: 0,
    held: false,
    category_chosen_at: null,
    staleness: { reasons: [], waiting_since: null },
    requests: [
      {
        id: "req-1",
        note: "I'd give this a wonderful home on my own kitchen counter.",
        created_at: Date.now() - 60_000,
        status: "open",
        email_masked: "p•••@keepsake.ing",
        notify_failed: false,
      },
    ],
    moderation: { status: "approved", held: false },
  };
}

function detailWithChosenRequest(): OwnerListingDetail {
  const base = detailWithOpenRequest();
  return {
    ...base,
    chosen_request_id: "req-1",
    requests: [
      {
        id: "req-1",
        note: base.requests[0]?.note ?? "",
        created_at: base.requests[0]?.created_at ?? 0,
        status: "chosen",
        email_masked: "p•••@keepsake.ing",
        email: "person@keepsake.ing",
        phone: "+1 555 0100",
        notify_failed: false,
      },
    ],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("mine/[id] choose flow", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
    jest.mocked(chooseRequest).mockReset();
  });

  it("masks the requester's contact until chosen, then reveals it after Choose -> Confirm", async () => {
    jest.mocked(getMyListing).mockResolvedValueOnce(detailWithOpenRequest());

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("p•••@keepsake.ing");
    expect(JSON.stringify(instance.toJSON())).not.toContain("person@keepsake.ing");

    const chooseButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Choose" });
    await act(async () => {
      fireEvent.press(chooseButton);
      await flush();
    });

    jest.mocked(chooseRequest).mockResolvedValue({
      id: "req-1",
      note: "I'd give this a wonderful home on my own kitchen counter.",
      created_at: Date.now() - 60_000,
      status: "chosen",
      email_masked: "p•••@keepsake.ing",
      email: "person@keepsake.ing",
      phone: "+1 555 0100",
      notify_failed: false,
    });
    jest.mocked(getMyListing).mockResolvedValueOnce(detailWithChosenRequest());

    // Confirm starts disabled: an empty handoff note would be sent to the
    // requester verbatim (issue #373), so a note has to be typed first.
    const confirmButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Confirm" });
    expect(confirmButton.props.disabled).toBe(true);

    const noteField = instance.UNSAFE_getByProps({ accessibilityLabel: "Handoff note" });
    await act(async () => {
      fireEvent.changeText(noteField, "Free after 6pm on Elm St, ring the bell.");
      await flush();
    });

    await act(async () => {
      fireEvent.press(instance.UNSAFE_getByProps({ accessibilityLabel: "Confirm" }));
      await flush();
    });

    expect(jest.mocked(chooseRequest)).toHaveBeenCalledWith("listing-1", {
      request_id: "req-1",
      handoff_note: "Free after 6pm on Elm St, ring the bell.",
    });
    expect(JSON.stringify(instance.toJSON())).toContain("person@keepsake.ing");
  });

  // Issue #373 finding 2: two requests on the same listing, one Choose sheet
  // — nothing in it said which requester Confirm was about, and Confirm was
  // enabled with the handoff note (the whole body of the requester's email)
  // still empty.
  it("names the request the sheet is about, and starts Confirm disabled", async () => {
    const detail = detailWithOpenRequest();
    detail.requests = [
      { ...detail.requests[0]!, id: "req-1", email_masked: "h•••@keepsake.ing", note: "My mother had one exactly like this." },
      { ...detail.requests[0]!, id: "req-2", email_masked: "p•••@keepsake.ing", note: "I would give it to my daughter." },
    ];
    jest.mocked(getMyListing).mockResolvedValue(detail);

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    const chooseButtons = instance.UNSAFE_getAllByProps({ accessibilityLabel: "Choose" });
    const second = chooseButtons[1];
    if (second === undefined) throw new Error("expected two Choose buttons");
    await act(async () => {
      fireEvent.press(second);
      await flush();
    });

    const tree = JSON.stringify(instance.toJSON());
    // The second request's identity is visible inside the sheet ...
    expect(tree).toContain("p•••@keepsake.ing");
    expect(tree).toContain("I would give it to my daughter.");

    const confirmButton = instance.UNSAFE_getByProps({ accessibilityLabel: "Confirm" });
    expect(confirmButton.props.disabled).toBe(true);
  });

  // Issue #6: a rejected notification used to be indistinguishable from a
  // delivered one anywhere the giver could see — this is the dashboard half
  // of closing that gap. Two cases, since the failure means something
  // different depending on whose address bounced: the giver's own (they
  // never heard about the ask) or the chosen requester's (that person never
  // heard they were picked).
  it("shows a warm notice when the owner-notify failed on an open request", async () => {
    const detail = detailWithOpenRequest();
    const failedRequest = detail.requests[0];
    if (failedRequest === undefined) throw new Error("fixture missing its request");
    detail.requests = [{ ...failedRequest, notify_failed: true }];
    jest.mocked(getMyListing).mockResolvedValueOnce(detail);

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("We couldn't reach you about this one");
  });

  it("shows a warm notice when the chosen-notify failed", async () => {
    const detail = detailWithChosenRequest();
    const failedRequest = detail.requests[0];
    if (failedRequest === undefined) throw new Error("fixture missing its request");
    detail.requests = [{ ...failedRequest, notify_failed: true }];
    jest.mocked(getMyListing).mockResolvedValueOnce(detail);

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("We couldn't reach them to say you chose them");
  });
});

describe("mine/[id] staleness", () => {
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
  });

  async function renderDetail(staleness: OwnerListingDetail["staleness"]) {
    jest.mocked(getMyListing).mockResolvedValueOnce({ ...detailWithOpenRequest(), staleness });
    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });
    return JSON.stringify(instance.toJSON());
  }

  it("heads nothing when the listing needs nothing", async () => {
    expect(await renderDetail({ reasons: [], waiting_since: null })).not.toContain("Needs you");
  });

  it("names every reason at once, and offers the fix for the mailbox half", async () => {
    const shown = await renderDetail({
      reasons: ["requests_unanswered", "email_missing"],
      waiting_since: Date.now() - 9 * DAY,
    });

    expect(shown).toContain("Needs you");
    expect(shown).toContain("waiting 9 days");
    expect(shown).toContain("No email on this device");
    expect(shown).toContain("Add an email");
  });

  it("offers no email button when the only problem is the unanswered ask", async () => {
    const shown = await renderDetail({ reasons: ["requests_unanswered"], waiting_since: Date.now() - 4 * DAY });

    expect(shown).toContain("waiting 4 days");
    expect(shown).not.toContain("Add an email");
    expect(shown).not.toContain("Verify email");
  });
});

// Issue #362: the card opened with a coloured eyebrow reading the status, and
// then spent a rule and a heading on a Status section whose whole content was
// that same word again. The section now renders only when it has something the
// eyebrow cannot say.
describe("mine/[id] status section (#362)", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
  });

  async function renderDetail(detail: OwnerListingDetail): Promise<string> {
    jest.mocked(getMyListing).mockResolvedValue(detail);
    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });
    return JSON.stringify(instance.toJSON());
  }

  it("says Live once, in the eyebrow, and heads no Status section", async () => {
    const shown = await renderDetail(detailWithOpenRequest());

    expect(shown).toContain("Live");
    expect(shown.split("Live").length - 1).toBe(1);
    expect(shown).not.toContain("Status");
  });

  it("heads no Status section on a given listing either", async () => {
    const shown = await renderDetail({ ...detailWithOpenRequest(), status: "given" });

    expect(shown.split("Given").length - 1).toBe(1);
    expect(shown).not.toContain("Status");
  });

  it("keeps the section for a rejection, and carries the moderator's reason", async () => {
    const shown = await renderDetail({
      ...detailWithOpenRequest(),
      status: "rejected",
      moderation_reason: "contact_in_story",
    });

    expect(shown).toContain("Status");
    expect(shown).toContain(MODERATION_REASONS.contact_in_story);
    // The eyebrow is the only place the label itself appears.
    expect(shown.split("Needs attention").length - 1).toBe(1);
  });

  it("keeps the section for a closer look, and says how long that takes", async () => {
    const shown = await renderDetail({ ...detailWithOpenRequest(), status: "needs_review" });

    expect(shown).toContain("Status");
    expect(shown).toContain("Usually within a day.");
  });

  // The section used to carry the action error too, so hiding it on an
  // ordinary approved listing could have taken the error with it. It moved to
  // the buttons instead; the delete guard below is the other half of this.
  it("still shows an action error on a listing with no Status section", async () => {
    jest.mocked(getMyListing).mockResolvedValue(detailWithOpenRequest());
    jest.mocked(withdrawListing).mockRejectedValue(new ApiError("unavailable", "Couldn't reach Keepsake.", 0));

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).not.toContain("Status");

    await act(async () => {
      fireEvent.press(instance.UNSAFE_getByProps({ accessibilityLabel: "Withdraw" }));
      await flush();
    });

    expect(JSON.stringify(instance.toJSON())).toContain("Couldn't reach Keepsake.");
  });
});

// Issue #172. `runAction` swallowed the error and resolved either way, and
// `handleDelete` chained `.then(() => router.replace("/mine"))` onto it — so a
// DELETE that never reached the API still landed the giver on the dashboard,
// with the error state discarded by the unmount. They were shown a completed
// deletion for a listing that was still public.
describe("mine/[id] delete", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
    jest.mocked(deleteListing).mockReset();
    mockRouter.replace.mockReset();
    mockRouter.push.mockReset();
  });

  async function openDeleteConfirmAndPress(): Promise<ReturnType<typeof render>> {
    jest.mocked(getMyListing).mockResolvedValue(detailWithOpenRequest());

    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    // The bare "Delete" on the card opens the confirm sheet; the primary
    // "Delete" inside the sheet is the one that fires the request. `Sheet` is
    // mocked (above) to render its children inline once visible, so after the
    // first press both are on screen — the sheet's is the last.
    const openers = instance.UNSAFE_getAllByProps({ accessibilityLabel: "Delete" });
    const opener = openers[0];
    if (opener === undefined) throw new Error("no Delete control rendered");
    await act(async () => {
      fireEvent.press(opener);
      await flush();
    });

    const confirms = instance.UNSAFE_getAllByProps({ accessibilityLabel: "Delete" });
    const confirm = confirms[confirms.length - 1];
    if (confirm === undefined) throw new Error("no Delete confirm rendered");
    await act(async () => {
      fireEvent.press(confirm);
      await flush();
    });

    return instance;
  }

  it("GUARD: a failed delete does not navigate to /mine, and shows the error", async () => {
    // The exact error `apiFetch`'s catch produces for a dropped connection.
    jest
      .mocked(deleteListing)
      .mockRejectedValue(new ApiError("unavailable", "Couldn't reach Keepsake. Check your connection and try again.", 0));

    const instance = await openDeleteConfirmAndPress();

    expect(jest.mocked(deleteListing)).toHaveBeenCalledWith("listing-1");
    // The whole issue: this used to be called anyway.
    expect(mockRouter.replace).not.toHaveBeenCalled();
    // And the giver is told why, on the page they are still standing on.
    expect(JSON.stringify(instance.toJSON())).toContain("Couldn't reach Keepsake.");
  });

  it("navigates to /mine when the delete actually succeeds", async () => {
    jest.mocked(deleteListing).mockResolvedValue(undefined);

    await openDeleteConfirmAndPress();

    expect(jest.mocked(deleteListing)).toHaveBeenCalledWith("listing-1");
    expect(mockRouter.replace).toHaveBeenCalledWith("/mine");
  });
});

describe("mine/[id] category correction (#155)", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
    jest.mocked(setListingCategory).mockReset();
  });

  async function renderDetail(detail: OwnerListingDetail): Promise<ReturnType<typeof render>> {
    jest.mocked(getMyListing).mockResolvedValue(detail);
    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });
    return instance;
  }

  // Rendered copy is asserted through `toJSON()`, and controls through
  // `UNSAFE_getByProps({ accessibilityLabel })` — the convention the rest of
  // this file already uses, because react-native-web renders `Text` as a
  // `div` and RNTL's text queries never match it.
  it("says the category was guessed, and invites a correction", async () => {
    // The copy is the affordance. "We guessed this" is what tells a giver the
    // single word OTHER on their listing is theirs to fix (#135).
    const instance = await renderDetail(detailWithOpenRequest());
    const tree = JSON.stringify(instance.toJSON());
    expect(tree).toContain("Home & kitchen");
    expect(tree).toContain("We guessed this from your photo.");
    expect(tree).toContain("Change it if it's wrong.");
    expect(instance.UNSAFE_queryByProps({ accessibilityLabel: "Change category" })).not.toBeNull();
  });

  // Issue #356: the hint was gated on "was it guessed?" and the button on
  // "is it editable?", so a given listing kept the invitation after losing
  // the control that honoured it.
  it("drops the invitation, but keeps the provenance, once the keepsake has been given", async () => {
    const instance = await renderDetail({ ...detailWithOpenRequest(), status: "given" });
    const tree = JSON.stringify(instance.toJSON());
    expect(tree).toContain("We guessed this from your photo.");
    expect(tree).not.toContain("Change it if it's wrong.");
    expect(instance.UNSAFE_queryByProps({ accessibilityLabel: "Change category" })).toBeNull();
  });

  it("says the category is the giver's once they have chosen one", async () => {
    const instance = await renderDetail({ ...detailWithOpenRequest(), category_chosen_at: 1_700_000_000_000 });
    const tree = JSON.stringify(instance.toJSON());
    expect(tree).toContain("You chose this, so we'll leave it alone.");
    expect(tree).not.toContain("We guessed this from your photo.");
  });

  it("sends the giver's pick to the category endpoint, not a full edit", async () => {
    // `setListingCategory`, not `updateListing`: a PATCH would bump the
    // version and re-moderate, taking a live listing out of the feed to
    // change one word.
    jest.mocked(setListingCategory).mockResolvedValue({} as never);
    const instance = await renderDetail(detailWithOpenRequest());

    const opener = instance.UNSAFE_getByProps({ accessibilityLabel: "Change category" });
    await act(async () => {
      fireEvent.press(opener);
      await flush();
    });

    const chip = instance.UNSAFE_getByProps({ accessibilityLabel: "Tools & DIY" });
    await act(async () => {
      fireEvent.press(chip);
      await flush();
    });

    expect(jest.mocked(setListingCategory)).toHaveBeenCalledWith("listing-1", "tools_diy");
  });

  it("offers no correction once the keepsake has been given", async () => {
    const instance = await renderDetail({ ...detailWithOpenRequest(), status: "given" });
    // The section still says what the category is; only the control is gone.
    expect(JSON.stringify(instance.toJSON())).toContain("Home & kitchen");
    expect(instance.UNSAFE_queryByProps({ accessibilityLabel: "Change category" })).toBeNull();
  });
});

// Issue #355: `RequestList` had one empty-state line for every status, so a
// given listing told its giver to share a link to something already handed
// over. The screen now passes the status down and the line follows it. The
// exhaustive per-status check lives in test/features/mine/RequestList.test.tsx;
// these prove the screen wires the status through at all.
describe("mine/[id] empty requests by status (#355)", () => {
  beforeEach(() => {
    jest.mocked(getMyListing).mockReset();
  });

  async function renderEmpty(status: OwnerListingDetail["status"]): Promise<string> {
    jest.mocked(getMyListing).mockResolvedValue({ ...detailWithOpenRequest(), status, request_count: 0, requests: [] });
    const instance = render(
      <ToastProvider>
        <MineDetail />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });
    return JSON.stringify(instance.toJSON());
  }

  it("still asks a live listing's giver to share the link", async () => {
    const shown = await renderEmpty("approved");
    expect(shown).toContain("No one has asked yet. Share the link.");
  });

  it("says nobody asked before it found a home, and does not say share, once given", async () => {
    const shown = await renderEmpty("given");
    expect(shown).toContain("Nobody asked through Keepsake before this found its home.");
    expect(shown).not.toContain("Share the link");
  });

  it("does not ask a withdrawn listing's giver to share either", async () => {
    const shown = await renderEmpty("withdrawn");
    expect(shown).toContain("No one asked.");
    expect(shown).not.toContain("Share the link");
    expect(shown).not.toContain("found its home");
  });

  it("keeps 'yet', without the ask, while moderation has not yet made it live", async () => {
    const shown = await renderEmpty("pending");
    expect(shown).toContain("No one has asked yet.");
    expect(shown).not.toContain("Share the link");
  });
});
