import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplyQueuedEdits, BackupPage, NewPageInput, PageScene, PageView } from "../src/storage/types.ts";
import type { Store } from "./store.ts";

/** Required on every API call: a custom header can't be sent cross-site without a CORS preflight, which we never grant. */
export const API_HEADER = "x-meadowlark";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const WATCH_MS = 400;
const KEEPALIVE_MS = 25_000;

type Route = (store: Store, params: string[], body: unknown) => unknown;

// Each route returns the JSON response (null is a valid "not found" answer,
// matching StorageAdapter). Paths are matched against /api/<pattern>.
const ROUTES: [method: string, pattern: RegExp, route: Route][] = [
  ["GET", /^pages$/, (s) => s.listPages()],
  ["POST", /^pages$/, (s, _, b) => s.createPage(b as NewPageInput)],
  ["POST", /^pages\/put$/, (s, _, b) => s.putPages((b as { pages: BackupPage[] }).pages)],
  ["GET", /^pages\/([^/]+)$/, (s, [id]) => s.getPage(id)],
  ["PATCH", /^pages\/([^/]+)$/, (s, [id], b) => s.updatePageMeta(id, b as { name?: string })],
  ["DELETE", /^pages\/([^/]+)$/, (s, [id]) => s.deletePage(id)],
  ["PUT", /^pages\/([^/]+)\/pinned$/, (s, [id], b) => s.setPagePinned(id, (b as { pinned: boolean }).pinned === true)],
  ["POST", /^pages\/([^/]+)\/keep$/, (s, [id]) => s.keepPage(id)],
  ["PUT", /^pages\/([^/]+)\/saved$/, (s, [id], b) => s.setPageSaved(id, (b as { saved: boolean }).saved === true)],
  ["PUT", /^pages\/([^/]+)\/scene$/, (s, [id], b) => s.savePageScene(id, b as PageScene)],
  ["PUT", /^pages\/([^/]+)\/view$/, (s, [id], b) => s.savePageView(id, b as PageView)],
  ["POST", /^pages\/([^/]+)\/duplicate$/, (s, [id], b) => s.duplicatePage(id, (b as { name: string }).name)],
  ["GET", /^pages\/([^/]+)\/queue$/, (s, [id]) => s.getQueuedEdits(id)],
  ["POST", /^pages\/([^/]+)\/queue\/apply$/, (s, [id], b) => s.applyQueuedEdits(id, b as ApplyQueuedEdits)],
  ["DELETE", /^pages\/([^/]+)\/queue$/, (s, [id]) => s.discardQueuedEdits(id)],
  ["POST", /^pages\/([^/]+)\/claude\/revert$/, (s, [id]) => s.revertClaudeChange(id)],
  ["POST", /^pages\/([^/]+)\/claude\/dismiss$/, (s, [id]) => s.dismissClaudeChange(id)],
];

export interface Api {
  /** Handles /api/* requests. Returns false for anything else. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): void;
}

/**
 * The browser's view of the store, plus /api/events: a server-sent event
 * stream that fires whenever the data changes, whether the change came
 * through this API or from a Claude session writing the same file.
 */
export function createApi(store: Store): Api {
  const clients = new Set<ServerResponse>();
  let seq = 0;
  const notify = () => {
    seq++;
    for (const res of clients) res.write(`data: ${JSON.stringify({ seq })}\n\n`);
  };

  // data_version only moves when another connection commits, which is
  // exactly the MCP server's writes. Our own writes notify directly.
  let version = store.dataVersion();
  const watcher = setInterval(() => {
    const next = store.dataVersion();
    if (next !== version) {
      version = next;
      notify();
    }
  }, WATCH_MS);
  const keepalive = setInterval(() => {
    for (const res of clients) res.write(": keepalive\n\n");
  }, KEEPALIVE_MS);

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) return false;
      // Refuse requests addressed to another name (DNS rebinding).
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOCAL_HOSTS.has(host)) return send(res, 403, { error: "Meadowlark only answers on localhost." });
      const path = url.pathname.slice("/api/".length);

      if (req.method === "GET" && path === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ seq })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return true;
      }
      if (req.headers[API_HEADER] !== "1") return send(res, 403, { error: `Missing ${API_HEADER} header.` });

      for (const [method, pattern, route] of ROUTES) {
        const match = pattern.exec(path);
        if (!match || req.method !== method) continue;
        try {
          const body = method === "GET" || method === "DELETE" ? undefined : await readJson(req);
          const result = route(store, match.slice(1).map(decodeURIComponent), body);
          if (method !== "GET") notify();
          return send(res, 200, result ?? null);
        } catch (err) {
          console.error(`${method} /api/${path} failed`, err);
          return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return send(res, 404, { error: `No route for ${req.method} /api/${path}` });
    },
    close() {
      clearInterval(watcher);
      clearInterval(keepalive);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}
