/**
 * The payload the Worker inlines into `/item/:id` (apps/api/src/routes/item.ts)
 * and what the item screen is allowed to believe about it.
 *
 * The failure this guards against is not a crash: it is rendering the WRONG
 * keepsake. The tag stays in the document after a client-side navigation, so
 * a reader that trusted it would show the first keepsake's story under the
 * second keepsake's URL — and, because the screen then never fetches,
 * silently and for as long as the tab is open.
 */
import { readInlineListing } from "@/features/item/inlineListing";

const LISTING = {
  id: "01ABCDEFGHJKMNPQRSTVWXYZ00",
  title: "A quiet teacup",
  story: "She used it every single day for her first cup of tea.",
  category: "home_kitchen",
  place_name: "Somerville",
  admin1: "MA",
  country: "US",
  status: "approved",
  published_at: 1_757_000_000_000,
  photos: [],
  aspects: [],
};

function inlineTag(id: string, json: string): void {
  document.body.innerHTML = `<script type="application/json" id="ks-listing" data-id="${id}">${json}</script>`;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readInlineListing", () => {
  it("parses the payload the Worker wrote for this keepsake", () => {
    inlineTag(LISTING.id, JSON.stringify(LISTING));
    expect(readInlineListing(LISTING.id)?.title).toBe("A quiet teacup");
  });

  it("consumes it, so a later visit to the same keepsake asks the server again", () => {
    // The page it arrived with was served `no-store`: a listing can be given
    // away or hidden between two visits in one session, and a payload left
    // in the DOM is the one stale copy nothing invalidates.
    inlineTag(LISTING.id, JSON.stringify(LISTING));
    expect(readInlineListing(LISTING.id)).not.toBeNull();
    expect(readInlineListing(LISTING.id)).toBeNull();
    expect(document.getElementById("ks-listing")).toBeNull();
  });

  it("refuses a payload for a different keepsake", () => {
    // Tapping from one keepsake to another leaves the first one's tag in the
    // document. Believing it renders the wrong story under the right URL.
    inlineTag(LISTING.id, JSON.stringify(LISTING));
    expect(readInlineListing("01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });

  it("returns null rather than throwing on a payload that is not a listing", () => {
    inlineTag(LISTING.id, "{not json");
    expect(readInlineListing(LISTING.id)).toBeNull();

    inlineTag(LISTING.id, JSON.stringify({ ...LISTING, status: "pending" }));
    expect(readInlineListing(LISTING.id)).toBeNull();

    inlineTag(LISTING.id, JSON.stringify({ id: LISTING.id }));
    expect(readInlineListing(LISTING.id)).toBeNull();
  });

  it("returns null when there is no payload at all", () => {
    expect(readInlineListing(LISTING.id)).toBeNull();
  });
});
