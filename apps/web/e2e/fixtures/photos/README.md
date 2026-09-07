# UX baseline photographs

Seven photographs, one per keepsake in `e2e/support/demoCatalog.ts` plus the
one the give walkthrough posts. They exist so `docs/qa/baseline/` shows the
design doing its actual job — a photograph on a print on a table — rather than
the synthetic gradient `e2e/support/png.ts` generates. See the header comment
on `e2e/support/demoPhotos.ts` for why that distinction is worth 1.2 MB.

The functional specs still use `png.ts`. Nothing here is on their path.

## Licence

All seven are from [Pexels](https://www.pexels.com/license/), under the Pexels
License: free for personal and commercial use, no attribution required, and
modification permitted. They are downscaled here, which the licence allows.
The one restriction — you may not sell unaltered copies as stock — is not
something a test fixture in a private repository comes near.

Attribution is not required, but the source of each file is recorded below so
the set can be regenerated or a photo swapped without guesswork.

| file | Pexels ID | photo |
| --- | --- | --- |
| `kettle.jpg` | 8172859 | [a-kettle-on-a-gas-stove](https://www.pexels.com/photo/a-kettle-on-a-gas-stove-8172859/) |
| `brooch.jpg` | 16219625 | [cooper-brooch-in-shape-of-an-insect-on-a-blazer](https://www.pexels.com/photo/cooper-brooch-in-shape-of-an-insect-on-a-blazer-16219625/) |
| `letters.jpg` | 37947894 | [assortment-of-vintage-postcards-with-handwritten-notes](https://www.pexels.com/photo/assortment-of-vintage-postcards-with-handwritten-notes-37947894/) |
| `plane.jpg` | 38853401 | [vintage-hand-plane-on-carpentry-workbench](https://www.pexels.com/photo/vintage-hand-plane-on-carpentry-workbench-38853401/) |
| `records.jpg` | 1759350 | [assorted-vinyl-sleeves](https://www.pexels.com/photo/assorted-vinyl-sleeves-1759350/) |
| `quilt.jpg` | 8266835 | [patchwork-quilt-on-bed](https://www.pexels.com/photo/patchwork-quilt-on-bed-8266835/) |
| `butterdish.jpg` | 35202690 | [elegant-glass-candy-dish-on-vintage-table](https://www.pexels.com/photo/elegant-glass-candy-dish-on-vintage-table-35202690/) |

## Regenerating

Each `<key>.jpg` is the source fitted to 1200px on the long edge at quality 82;
each `<key>.thumb.jpg` is the same image at 400px. Aspect ratios are left as
shot — five portrait, one wide — because a uniform set would stop exercising
`clampCardAspectRatio()`.

To replace one, download the original, then:

```sh
python3 - <<'PY'
from PIL import Image, ImageOps
src, key = "downloaded.jpg", "kettle"
im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
ImageOps.contain(im, (1200, 1200), Image.LANCZOS).save(f"{key}.jpg", quality=82, optimize=True, progressive=True)
ImageOps.contain(im, (400, 400), Image.LANCZOS).save(f"{key}.thumb.jpg", quality=80, optimize=True)
im.convert("RGBA").resize((64, 64), Image.LANCZOS).save(f"/tmp/{key}.rgba", "raw")
PY
```

Then update that entry's `width`, `height` and `blurhash` in
`e2e/support/demoPhotos.ts`. The blurhash must come from the app's own
`blurhash` package, so the placeholder matches what the app will decode:

```sh
cd apps/web && node -e '
const {encode} = require("blurhash"), fs = require("fs");
const px = new Uint8ClampedArray(fs.readFileSync("/tmp/kettle.rgba"));
console.log(encode(px, 64, 64, 4, 3));
'
```
