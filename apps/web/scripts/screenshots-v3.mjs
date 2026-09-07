#!/usr/bin/env node
// M2/M3 screenshots: feed (masonry, location bar, search), item page, and
// recovery — extends scripts/screenshots-v2.mjs's method (Chrome DevTools
// Protocol over Node's built-in WebSocket, no puppeteer) rather than
// duplicating it from scratch.
//
//   node scripts/screenshots-v3.mjs [baseUrl] [itemId]
//     baseUrl default http://127.0.0.1:8787
//     itemId  default 01LISTINGSEEDAAAAAAAAAAAA (this milestone's seeded
//             local listing; pass the real preview feed's approved id to
//             shoot against https://keepsake-preview.leapkg.workers.dev)
//
// Writes apps/web/screenshots/v3-<route>-<width>-<scheme>.png (the real,
// viewport-bounded screenshot — what a visitor actually sees before
// scrolling) and, separately, a v3-<route>-<width>-<scheme>-full.png (the
// whole scrollable page, via `captureBeyondViewport`). Only the `-full` shot
// resizes the emulated device to the page's full content height; the plain
// one does not, on purpose. It used to be the only shot this script took,
// which is exactly why M0's "no page scrolls" bug (see
// docs/plans/give-flow bug report / src/ui/Page.tsx) went unnoticed for so
// long — a screenshot rendered "as if scrolled" can't ever show a scroll
// failure. Assumes a server is already serving apps/web/dist at baseUrl
// (e.g. `pnpm --filter @keepsake/api dev`) and a Chrome binary at the path
// below.
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const ITEM_ID = process.argv[3] ?? "01LISTINGSEEDAAAAAAAAAAAA";
const PORT = 9334;
const OUT = resolve(new URL(".", import.meta.url).pathname, "../screenshots");
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { route: "/", name: "home", width: 390, scheme: "light" },
  { route: "/", name: "home", width: 390, scheme: "dark" },
  { route: "/", name: "home", width: 1280, scheme: "light" },
  { route: "/", name: "home", width: 1280, scheme: "dark" },
  { route: `/item/${ITEM_ID}`, name: "item", width: 390, scheme: "light" },
  { route: "/recover", name: "recover", width: 390, scheme: "light" },
];

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--user-data-dir=/tmp/keepsake-shots-v3-profile`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome devtools endpoint never came up");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const once = (method) =>
    new Promise((resolve) => {
      const fn = (params) => {
        listeners.get(method).delete(fn);
        resolve(params);
      };
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
    });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ send, once, close: () => ws.close() }));
    ws.addEventListener("error", reject);
  });
}

async function shoot({ route, name, width, scheme }) {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: width < 700 });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${BASE}${route}` });
  await loaded;
  // Hydration + fonts + the first reanimated frame.
  await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  await sleep(1800);

  const probe = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const wm = document.querySelector('[data-testid="wordmark"]');
      const cs = wm ? getComputedStyle(wm) : null;
      return {
        theme: document.documentElement.dataset.theme,
        wordmark: cs ? { fontFamily: cs.fontFamily, fontStyle: cs.fontStyle, fontVariationSettings: cs.fontVariationSettings, fontOpticalSizing: cs.fontOpticalSizing } : null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)),
      };
    })()`,
  });
  const info = probe.result.value;

  // The viewport-only shot, at the fixed device height set above — captured
  // *before* the full-page resize below, so this is genuinely what's on
  // screen without scrolling. This is the one that would have caught the
  // "no page scrolls" bug: a page whose content never made it past the fold
  // now visibly cuts off here instead of always looking complete.
  const viewportShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `v3-${name}-${width}-${scheme}.png`), Buffer.from(viewportShot.data, "base64"));

  const height = Math.min(Math.max(info.height, 700), 9000);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 700 });
  await sleep(300);

  // Hover probe (after the full-height resize, so the card is inside the viewport): move the mouse over the first feed card and read back its
  // transform, so the lift/tilt is verified in the DOM even though a still
  // can't show it. Only meaningful on the home route at desktop width.
  if (route === "/" && width >= 700) {
    const box = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => { const el = document.querySelector('[data-testid="feed-card-first"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    });
    const center = box.result.value;
    if (center) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
      await sleep(400);
      const hovered = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => { const el = document.querySelector('[data-testid="feed-card-first"]'); const cs = getComputedStyle(el); return { transform: cs.transform, boxShadow: cs.boxShadow }; })()`,
      });
      console.log(`  hover: ${JSON.stringify(hovered.result.value)}`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
      await sleep(400);
    }
  }
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = join(OUT, `v3-${name}-${width}-${scheme}-full.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`${file}  theme=${info.theme} bodyBg=${info.bodyBg} height=${height}`);
  console.log(`  wordmark: ${JSON.stringify(info.wordmark)}`);
  cdp.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
}

try {
  await waitForDevtools();
  for (const s of SHOTS) await shoot(s);
} finally {
  chrome.kill("SIGTERM");
}
