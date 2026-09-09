/**
 * Helpers for asking a rendered tree "what is this text printed on?" — the
 * form a test has to take to fail on #216/#358, where constant ink was drawn
 * straight onto the table and vanished under the dark lamp. A test that
 * only asserts "the heading is rendered" passes in both states.
 *
 * `test/app/mine/index.test.tsx` grew the first copy of these for #216;
 * this file is the same functions lifted out so the `/admin` tests
 * (`test/app/admin.test.tsx`, `test/features/admin/Observatory.test.tsx`)
 * could share them. That file still carries its own copy.
 */

/** One host node of `render().toJSON()`. */
export type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] | null };

/** WCAG AA for body text. */
export const AA = 4.5;

export function styleOf(node: Node): Record<string, string> {
  return (node.props.style ?? {}) as Record<string, string>;
}

const RGBA = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/;

/** react-native-web resolves tokens to `rgba(r,g,b,a)`; `contrastRatio()`
 * speaks `#RRGGBB`. A translucent ground is rejected rather than composited:
 * contrast off a guessed blend would be a number nobody could check. */
export function hexOf(color: string | undefined): string {
  const m = color === undefined ? null : RGBA.exec(color);
  if (m === null) throw new Error(`not an rgba() colour: ${String(color)}`);
  if (Number(m[4]) !== 1) throw new Error(`${color} is translucent`);
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Every node in the tree, each with the ancestors it hangs from (nearest
 * first) — enough to answer "what is this heading actually printed on?".
 * `toJSON()` hands back an array when the tree has more than one root, which
 * it does under `ToastProvider`: the toast renders alongside the screen. */
export function walk(node: Node | Node[] | string | null, ancestors: Node[] = []): { node: Node; ancestors: Node[] }[] {
  if (node === null || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((child) => walk(child, ancestors));
  const chain = [node, ...ancestors];
  return [{ node, ancestors }, ...(node.children ?? []).flatMap((child) => walk(child, chain))];
}

/** The words a node carries directly, for an error message. */
function describeNode(node: Node): string {
  const words = (node.children ?? []).filter((c): c is string => typeof c === "string").join(" ");
  return words !== "" ? `"${words}"` : String(node.props["aria-label"] ?? node.type);
}

/**
 * The paper a node is printed on: the nearest ancestor with an opaque
 * background, as `#RRGGBB`. A fully transparent background (a ghost
 * button's `Pressable`, say) is not paper and is skipped; a translucent one
 * is rejected, for the reason `hexOf` gives. Throws — naming the words —
 * when nothing but the table is under the node, which is exactly the #358
 * failure: the table is painted by `KraftTable` outside the tree a screen
 * test renders, so "no opaque ancestor" and "on the table" are the same
 * thing here.
 */
export function paperUnder(node: Node, ancestors: Node[]): string {
  for (const ancestor of ancestors) {
    const bg = styleOf(ancestor).backgroundColor;
    if (typeof bg !== "string" || bg === "transparent") continue;
    const m = RGBA.exec(bg);
    if (m !== null && Number(m[4]) === 0) continue;
    return hexOf(bg);
  }
  throw new Error(`${describeNode(node)} is printed on the table, not on paper`);
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (m === null || m[1] === undefined) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Alpha-composite `fg` (opaque `#RRGGBB`) at CSS `opacity` over `bg` (opaque
 * `#RRGGBB`), returning the resulting opaque `#RRGGBB`.
 *
 * Why this exists (issue #373, PR #378 review): a first cut of `Button`'s
 * inert state asserted `contrastRatio(onAccent, pencil)` — the two *tokens*
 * — while the component itself still applied the old `disabled` opacity
 * (0.65) on top of the new fill. CSS `opacity` blends the WHOLE element
 * (fill and label together, since the label is drawn opaque on the opaque
 * fill first) against whatever is behind it, so the pixels a visitor
 * actually sees are `mix(token, backdrop, opacity)`, not the token itself.
 * A test that reads the two source tokens back off the tree and calls
 * `contrastRatio` directly can pass while the rendered button is still a
 * washed-out, barely-legible block — exactly finding 6's complaint, one
 * opacity value away from "fixed". Composite before asserting.
 */
export function compositeOver(fg: string, opacity: number, bg: string): string {
  const [fr, fgv, fb] = parseHex(fg);
  const [br, bgv, bb] = parseHex(bg);
  const mix = (f: number, b: number): number => Math.round(opacity * f + (1 - opacity) * b);
  const toHex = (v: number): string => v.toString(16).padStart(2, "0");
  return `#${toHex(mix(fr, br))}${toHex(mix(fgv, bgv))}${toHex(mix(fb, bb))}`.toUpperCase();
}
