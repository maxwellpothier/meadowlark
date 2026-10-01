// `npm start`: serves the built app (dist/) and its API on localhost.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { createApi } from "./api.ts";
import { startBackups } from "./backups.ts";
import { defaultDbPath, openDb } from "./db.ts";
import { Store } from "./store.ts";

const PORT = Number(process.env.PORT ?? 5173);
const DIST = resolve(import.meta.dirname, "../dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

if (!existsSync(join(DIST, "index.html"))) {
  console.error("No build found. Run `npm run build` first (or `npm run dev`).");
  process.exit(1);
}

const store = new Store(openDb());
const api = createApi(store);
startBackups(store);

const server = createServer((req, res) => {
  void api.handle(req, res).then((handled) => {
    if (handled) return;
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    let file = normalize(join(DIST, path));
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Meadowlark: http://localhost:${PORT}  (data: ${defaultDbPath()})`);
});
