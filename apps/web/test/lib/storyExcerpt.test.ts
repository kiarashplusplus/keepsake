import { storyExcerpt } from "@/lib/storyExcerpt";

describe("storyExcerpt", () => {
  it("returns a short first sentence unchanged", () => {
    expect(storyExcerpt("My grandmother made this. It sat on her shelf for decades.")).toBe("My grandmother made this.");
  });

  it("truncates a long single sentence at a word boundary with an ellipsis", () => {
    const long = "This mug has been in my family since before I was born and it has no punctuation to break on at all here";
    const result = storyExcerpt(long, 40);
    expect(result.length).toBeLessThanOrEqual(41);
    expect(result.endsWith("…")).toBe(true);
    expect(result.endsWith(" …")).toBe(false);
  });

  it("returns the whole story when it's already short and unpunctuated", () => {
    expect(storyExcerpt("A small brass compass")).toBe("A small brass compass");
  });
});
