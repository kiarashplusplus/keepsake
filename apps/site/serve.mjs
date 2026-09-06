#!/usr/bin/env node
/**
 * Tiny static preview server for apps/site.
 *
 * Maps /fonts/* -> apps/site/.preview-fonts (gitignored local copies of the
 * app's fonts) and everything else -> apps/site/public.
 *
 * In production the files under public/ are copied verbatim into the app's
 * static export by apps/web's scripts/copy-site.mjs, and fonts are served
 * by the app itself at the same paths. This server exists only so the site
 * can be previewed standalone, at the same URL shape.
 *
 * Usage: node apps/site/serve.mjs [port]   (default 4321)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(here, "public");
const fontsDir = join(here, ".preview-fonts");
const port = Number(process.argv[2]) || 4321;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

async function resolveFile(root, urlPath) {
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(root, safePath);
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, "index.html");
    await stat(filePath);
    return filePath;
  } catch {
    // Mirror the Workers assets binding: `/about` serves `about.html`.
    try {
      await stat(`${filePath}.html`);
      return `${filePath}.html`;
    } catch {
      return null;
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);

  const root = pathname.startsWith("/fonts/") ? fontsDir : publicDir;
  const rel = pathname.startsWith("/fonts/") ? pathname.slice("/fonts".length) : pathname;

  const filePath = await resolveFile(root, rel);
  if (!filePath) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found: " + pathname);
    return;
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("500 Internal Server Error: " + String(err));
  }
});

server.listen(port, () => {
  console.log(`Keepsake site preview: http://localhost:${port}/about`);
});
