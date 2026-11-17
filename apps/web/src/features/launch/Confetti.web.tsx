// One burst of paper confetti over the whole window, then nothing.
//
// The design system's motion vocabulary is otherwise strictly physical and
// strictly quiet (`@keepsake/tokens/motion`: "nothing else should animate").
// This is the one sanctioned exception, for one week, and it stays inside
// the identity as far as a party can: the pieces are scraps of the same
// paper everything else is cut from — stamp red, brass foil, tape, linen —
// square-cornered, tumbling, and they fall under gravity and stop. No loop.
//
// A canvas rather than a few hundred animated DOM nodes: it is one element,
// it is `pointer-events: none` so the dialog underneath stays clickable, and
// it removes itself when the last scrap leaves the window. The caller does
// not render this at all under reduce-motion.
import * as React from "react";
import { createPortal } from "react-dom";

type Scrap = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  spin: number;
  spinSpeed: number;
  /** Phase of the edge-on flutter, so scraps read as flat paper turning over. */
  flip: number;
  flipSpeed: number;
  color: string;
};

const COUNT = 150;
const GRAVITY = 0.16;
const DRAG = 0.992;
/** Hard stop, in case a tab is backgrounded mid-burst and frames stall. */
const MAX_MS = 9000;

function makeScraps(width: number, height: number, colors: readonly string[]): Scrap[] {
  const scraps: Scrap[] = [];
  for (let i = 0; i < COUNT; i += 1) {
    // Two cannons, low at either edge, firing up and inward.
    const fromLeft = i % 2 === 0;
    const angle = (fromLeft ? -Math.PI / 3 : (-2 * Math.PI) / 3) + (Math.random() - 0.5) * 0.9;
    const speed = (8 + Math.random() * 10) * Math.min(1.25, Math.max(0.75, height / 800));
    scraps.push({
      x: fromLeft ? -10 : width + 10,
      y: height * (0.55 + Math.random() * 0.25),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 7,
      h: 9 + Math.random() * 9,
      spin: Math.random() * Math.PI * 2,
      spinSpeed: (Math.random() - 0.5) * 0.3,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 0.08 + Math.random() * 0.14,
      color: colors[i % colors.length] as string,
    });
  }
  return scraps;
}

export function Confetti({ colors }: { colors: readonly string[] }): React.ReactElement | null {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [done, setDone] = React.useState(false);
  // The palette is fixed for the life of one burst; a ref keeps the effect
  // from restarting the animation if the caller hands in a fresh array.
  const colorsRef = React.useRef(colors);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    let width = window.innerWidth;
    let height = window.innerHeight;
    const size = (): void => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    };
    size();
    window.addEventListener("resize", size);

    const scraps = makeScraps(width, height, colorsRef.current);
    const startedAt = performance.now();
    let frame = 0;

    const tick = (now: number): void => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      let alive = 0;
      for (const scrap of scraps) {
        scrap.vx *= DRAG;
        scrap.vy = scrap.vy * DRAG + GRAVITY;
        scrap.x += scrap.vx + Math.sin(scrap.flip) * 0.6;
        scrap.y += scrap.vy;
        scrap.spin += scrap.spinSpeed;
        scrap.flip += scrap.flipSpeed;
        if (scrap.y < height + 30) alive += 1;
        context.save();
        context.translate(scrap.x, scrap.y);
        context.rotate(scrap.spin);
        context.scale(1, Math.cos(scrap.flip));
        context.fillStyle = scrap.color;
        context.fillRect(-scrap.w / 2, -scrap.h / 2, scrap.w, scrap.h);
        context.restore();
      }
      if (alive === 0 || now - startedAt > MAX_MS) {
        setDone(true);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", size);
    };
  }, []);

  if (done || typeof document === "undefined") return null;
  const target = document.getElementById("root");
  if (target === null) return null;

  return createPortal(
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="launch-confetti"
      style={{
        // Same reasoning as `Sheet`'s overlay for `absolute` at `#root`:
        // the containing block there is the viewport. Above the sheet (100),
        // below a toast (1000) and the consent bar (9999).
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100dvh",
        zIndex: 150,
        pointerEvents: "none",
      }}
    />,
    target,
  );
}
