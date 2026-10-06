import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { QueuedEdit } from "../claude/model";
import { liveElements, referencedFileIds } from "./scene";
import type {
  ApplyQueuedEdits,
  BackupPage,
  NewPageInput,
  Page,
  PageMeta,
  PageScene,
  PageView,
  StorageAdapter,
} from "./types";

interface SaveResult {
  meta: PageMeta;
  missingFiles: string[];
}

// Small enough for fetch's keepalive budget (64 KiB across in-flight requests),
// which is what lets a save started from beforeunload finish after the tab goes.
const KEEPALIVE_LIMIT = 48 * 1024;

/** Talks to the local Meadowlark server (server/api.ts), which keeps the data in SQLite. */
export class HttpAdapter implements StorageAdapter {
  /** Image ids the server already has, per page, so saves only upload new images. */
  private storedFiles = new Map<string, Set<string>>();

  listPages(): Promise<PageMeta[]> {
    return call("GET", "pages");
  }

  async getPage(id: string): Promise<Page | null> {
    const page = await call<Page | null>("GET", `pages/${enc(id)}`);
    if (page) this.storedFiles.set(id, new Set(Object.keys(page.files)));
    return page;
  }

  async createPage(input: NewPageInput): Promise<PageMeta> {
    const meta = await call<PageMeta>("POST", "pages", input);
    this.storedFiles.set(meta.id, referencedFileIds(input.elements ?? []));
    return meta;
  }

  async savePageScene(id: string, scene: PageScene): Promise<PageMeta | null> {
    const elements = liveElements(scene.elements);
    const known = this.storedFiles.get(id) ?? new Set<string>();
    const files = pick(scene.files, [...referencedFileIds(elements)].filter((f) => !known.has(f)));
    let result = await call<SaveResult | null>("PUT", `pages/${enc(id)}/scene`, { elements, appState: scene.appState, files });
    if (!result) return null;
    // The server lost track of an image we have (e.g. after a restore elsewhere): send it once more.
    const resend = pick(scene.files, result.missingFiles);
    if (Object.keys(resend).length > 0) {
      result = await call<SaveResult | null>("PUT", `pages/${enc(id)}/scene`, { elements, appState: scene.appState, files: resend });
      if (!result) return null;
    }
    const missing = new Set(result.missingFiles);
    this.storedFiles.set(id, new Set([...referencedFileIds(elements)].filter((f) => !missing.has(f))));
    return result.meta;
  }

  async savePageView(id: string, view: PageView): Promise<void> {
    await call("PUT", `pages/${enc(id)}/view`, view);
  }

  updatePageMeta(id: string, patch: Partial<Pick<PageMeta, "name">>): Promise<PageMeta | null> {
    return call("PATCH", `pages/${enc(id)}`, patch);
  }

  setPagePinned(id: string, pinned: boolean): Promise<PageMeta | null> {
    return call("PUT", `pages/${enc(id)}/pinned`, { pinned });
  }

  keepPage(id: string): Promise<PageMeta | null> {
    return call("POST", `pages/${enc(id)}/keep`);
  }

  setPageSaved(id: string, saved: boolean): Promise<PageMeta | null> {
    return call("PUT", `pages/${enc(id)}/saved`, { saved });
  }

  duplicatePage(id: string, name: string): Promise<PageMeta | null> {
    return call("POST", `pages/${enc(id)}/duplicate`, { name });
  }

  async deletePage(id: string): Promise<void> {
    await call("DELETE", `pages/${enc(id)}`);
    this.storedFiles.delete(id);
  }

  async putPages(pages: BackupPage[]): Promise<void> {
    await call("POST", "pages/put", { pages });
    for (const page of pages) this.storedFiles.delete(page.id);
  }

  getQueuedEdits(id: string): Promise<QueuedEdit[]> {
    return call("GET", `pages/${enc(id)}/queue`);
  }

  applyQueuedEdits(id: string, apply: ApplyQueuedEdits): Promise<PageMeta | "conflict" | null> {
    return call("POST", `pages/${enc(id)}/queue/apply`, apply);
  }

  async discardQueuedEdits(id: string): Promise<void> {
    await call("DELETE", `pages/${enc(id)}/queue`);
  }

  async revertClaudeChange(id: string): Promise<PageMeta | null> {
    this.storedFiles.delete(id);
    return call("POST", `pages/${enc(id)}/claude/revert`);
  }

  async dismissClaudeChange(id: string): Promise<void> {
    await call("POST", `pages/${enc(id)}/claude/dismiss`);
  }
}

/** Calls server/api.ts. Starts the request synchronously (see storage/serialized.ts). */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { "content-type": "application/json", "x-meadowlark": "1" },
    body: json,
    keepalive: json !== undefined && json.length < KEEPALIVE_LIMIT,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail as { error?: string } | null)?.error ?? `${method} ${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function pick(files: BinaryFiles, ids: Iterable<string>): BinaryFiles {
  const out: BinaryFiles = {};
  for (const id of ids) if (files[id]) out[id] = files[id];
  return out;
}
