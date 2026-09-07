import { decode } from "blurhash";
import { FALLBACK_BLURHASH } from "@/lib/images/blurhash";
import { PublicPhoto } from "@keepsake/contracts/photo";

describe("FALLBACK_BLURHASH", () => {
  // The constant is generated, not hand-written: a blurhash's first character
  // encodes its component count, so a plausible-looking literal is not
  // necessarily a valid hash. This decodes it to prove it is one.
  it("is a real, decodable blurhash", () => {
    expect(() => decode(FALLBACK_BLURHASH, 4, 4)).not.toThrow();
  });

  // It is only useful if the API will accept it — `PublicPhoto.blurhash` is
  // `z.string().min(6)`, and a 1x1-component hash is exactly six characters,
  // which is what makes it the natural fallback rather than an arbitrary one.
  it("satisfies the PublicPhoto schema the upload response is parsed against", () => {
    const parsed = PublicPhoto.safeParse({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      width: 800,
      height: 600,
      blurhash: FALLBACK_BLURHASH,
      url_full: "/i/01ARZ3NDEKTSV4RRFFQ69G5FAV/full",
      url_thumb: "/i/01ARZ3NDEKTSV4RRFFQ69G5FAV/thumb",
    });
    expect(parsed.success).toBe(true);
  });
});
