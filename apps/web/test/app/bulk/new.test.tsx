import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { createBatch } from "@/api/bulk";
import { lookupPostalCode } from "@/api/geo";
import { getMe, setEmail } from "@/api/me";
import { ApiError } from "@/api/client";
import { getOrCreateOwnerToken } from "@/lib/ownerToken";
import NewBulkBatch from "../../../app/bulk/new";

const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

jest.mock("@/api/bulk", () => ({ createBatch: jest.fn() }));
jest.mock("@/api/geo", () => ({ lookupPostalCode: jest.fn() }));
jest.mock("@/api/me", () => ({ getMe: jest.fn(), setEmail: jest.fn() }));

// Same fake widget as `test/app/mine/email.test.tsx` — it reports `ready`
// with one token, so a test can assert the token actually reaches
// `setEmail`, and `reset()` puts it back to `pending`. `latestOnStatus`
// lets a test hand over a *fresh* token afterwards, which is what the real
// widget does on its own and what a retry after a refused save depends on.
let latestOnStatus: ((status: { status: "ready"; token: string } | { status: "pending" }) => void) | null = null;
jest.mock("@/ui/Turnstile", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Turnstile: ReactActual.forwardRef(
      (
        { onStatus }: { onStatus: (status: { status: "ready"; token: string } | { status: "pending" }) => void },
        ref: React.Ref<{ reset: () => void }>,
      ) => {
        latestOnStatus = onStatus;
        ReactActual.useImperativeHandle(ref, () => ({ reset: () => onStatus({ status: "pending" }) }), [onStatus]);
        ReactActual.useEffect(() => {
          onStatus({ status: "ready", token: "T1" });
        }, [onStatus]);
        return null;
      },
    ),
  };
});

const BATCH_SUMMARY = {
  id: "01BATCHA000000000000000000",
  client_batch_key: "unused-because-caller-mints-it",
  name: "Mum's house",
  country: "US" as const,
  postal_code: "02144",
  place_name: "Somerville",
  admin1: "MA",
  shared_story: null,
  state: "draft" as const,
  revision: 1,
  item_count: 0,
  ready_count: 0,
  photo_count: 0,
  created_at: 1,
  updated_at: 1,
  expires_at: 999999,
};

/**
 * Fills name + postcode + email and lets the debounced lookup settle.
 *
 * The email is one of the required fields now (a batch with no address
 * behind it is dozens of listings nobody can be told about — see
 * `app/bulk/new.tsx`'s header), so it belongs here rather than in the three
 * tests that care about it specifically. Pass `null` to leave the field
 * exactly as the test found it, which is what the prefill case needs.
 */
async function fillRequiredFields(email: string | null = "giver@keepsake.ing"): Promise<void> {
  fireEvent.changeText(screen.getByLabelText("Batch name"), "Mum's house");
  fireEvent.changeText(screen.getByLabelText("Postcode"), "02144");
  if (email !== null) fireEvent.changeText(screen.getByLabelText("Email"), email);
  await act(async () => {
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pressStart(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByLabelText("Start this batch"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("bulk/new", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.useFakeTimers();
    mockReplace.mockReset();
    jest.mocked(createBatch).mockReset();
    jest.mocked(lookupPostalCode).mockReset();
    jest.mocked(getMe).mockReset();
    jest
      .mocked(setEmail)
      .mockReset()
      .mockResolvedValue({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", email: "giver@keepsake.ing", email_verified: false, banned: false });
    latestOnStatus = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("never calls createBatch before a postcode has resolved, even with every other field filled in", async () => {
    // Deliberately never resolves — the postcode lookup effect is still
    // debouncing/in flight the whole test.
    jest.mocked(lookupPostalCode).mockReturnValue(new Promise(() => {}));
    render(<NewBulkBatch />);

    await fillRequiredFields();
    await pressStart();

    expect(createBatch).not.toHaveBeenCalled();
  });

  it("creates the batch, saves it locally, and navigates to its photos step — no admission code anywhere in the form", async () => {
    jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
    jest.mocked(createBatch).mockResolvedValue({ ok: true, data: BATCH_SUMMARY });
    render(<NewBulkBatch />);

    expect(screen.queryByLabelText("Admission code")).toBeNull();

    await fillRequiredFields();
    await pressStart();

    expect(createBatch).toHaveBeenCalledWith(expect.objectContaining({ name: "Mum's house", country: "US", postal_code: "02144" }));
    // One argument: the old second `{ grantId }` argument is gone, not
    // merely unused.
    expect(jest.mocked(createBatch).mock.calls[0]).toHaveLength(1);
    expect(mockReplace).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/bulk/[batchKey]/photos" }));
  });

  it("shows the API's own error message on a failed create, and does not navigate", async () => {
    jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
    jest.mocked(createBatch).mockResolvedValue({
      ok: false,
      error: { kind: "limit_reached", message: "Today's item limit for this account has been reached." },
    });
    render(<NewBulkBatch />);

    await fillRequiredFields();
    await pressStart();

    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(screen.toJSON())).toContain("Today's item limit");
  });

  describe("the email, added here instead of on another screen", () => {
    it("creates the batch, then saves a typed address through setEmail, then navigates", async () => {
      jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
      jest.mocked(createBatch).mockResolvedValue({ ok: true, data: BATCH_SUMMARY });
      jest.mocked(setEmail).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@keepsake.ing", email_verified: false, banned: false });
      render(<NewBulkBatch />);

      await fillRequiredFields("person@keepsake.ing");
      await pressStart();

      expect(setEmail).toHaveBeenCalledWith({ email: "person@keepsake.ing" }, { turnstileToken: "T1" });
      expect(createBatch).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/bulk/[batchKey]/photos" }));
    });

    it("starts no batch at all when the field is left empty — it is required now, not optional", async () => {
      jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
      jest.mocked(createBatch).mockResolvedValue({ ok: true, data: BATCH_SUMMARY });
      render(<NewBulkBatch />);

      await fillRequiredFields(null);
      await pressStart();

      expect(setEmail).not.toHaveBeenCalled();
      expect(createBatch).not.toHaveBeenCalled();
      expect(JSON.stringify(screen.toJSON())).toContain("We need an email");
    });

    it("refuses a malformed address without calling either API", async () => {
      jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
      render(<NewBulkBatch />);

      await fillRequiredFields("not-an-address");
      await pressStart();

      expect(setEmail).not.toHaveBeenCalled();
      expect(createBatch).not.toHaveBeenCalled();
      expect(JSON.stringify(screen.toJSON())).toContain("doesn't look like an email address");
    });

    it("keeps the giver on the form when the address is refused, and a second press retries against the same batch", async () => {
      jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
      jest.mocked(createBatch).mockResolvedValue({ ok: true, data: BATCH_SUMMARY });
      jest.mocked(setEmail).mockRejectedValueOnce(new ApiError("bad_request", "That address can't receive mail.", 400));
      render(<NewBulkBatch />);

      await fillRequiredFields("person@keepsake.ing");
      await pressStart();

      expect(mockReplace).not.toHaveBeenCalled();
      const shown = JSON.stringify(screen.toJSON());
      expect(shown).toContain("can't receive mail");
      // The batch is not lost, and the giver is told so.
      expect(shown).toContain("Your batch is saved");

      // The retry: a fresh challenge token arrives (the widget refreshes
      // itself after the failed save spent the last one), then the same
      // client key resolves to the batch the first press created rather
      // than starting a second one.
      jest.mocked(setEmail).mockResolvedValueOnce({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@keepsake.ing", email_verified: false, banned: false });
      await act(async () => {
        latestOnStatus?.({ status: "ready", token: "T2" });
        await Promise.resolve();
      });
      await pressStart();

      const calls = jest.mocked(createBatch).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[0]?.client_batch_key).toBe(calls[1]?.[0]?.client_batch_key);
      expect(mockReplace).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/bulk/[batchKey]/photos" }));
    });

    it("prefills an address this device already has, and doesn't re-save it", async () => {
      getOrCreateOwnerToken();
      jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
      jest.mocked(createBatch).mockResolvedValue({ ok: true, data: BATCH_SUMMARY });
      jest.mocked(getMe).mockResolvedValue({ id: "01OWNERAAAAAAAAAAAAAAAAAA", email: "person@keepsake.ing", email_verified: true, banned: false });
      render(<NewBulkBatch />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByLabelText("Email").props.value).toBe("person@keepsake.ing");

      await fillRequiredFields(null);
      await pressStart();

      expect(setEmail).not.toHaveBeenCalled();
      expect(createBatch).toHaveBeenCalled();
    });

    it("never asks for an owner identity just to render the form", () => {
      jest.mocked(lookupPostalCode).mockResolvedValue({ country: "US", code: "02144", place_name: "Somerville", admin1: "MA", lat: 0, lng: 0 });
      render(<NewBulkBatch />);

      expect(getMe).not.toHaveBeenCalled();
      expect(window.localStorage.getItem("keepsake.ownerToken.v1")).toBeNull();
    });
  });
});
