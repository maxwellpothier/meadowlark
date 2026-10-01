import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import { prepareEdit, projectEdits, toShapes, type NewShape, type PageEdit, type QueuedEdit, type Shape } from "../src/claude/model.ts";
import { liveElements, referencedFileIds } from "../src/storage/scene.ts";
import type {
  ApplyQueuedEdits,
  BackupPage,
  NewPageInput,
  Page,
  PageMeta,
  PageScene,
  PageView,
  PersistedAppState,
} from "../src/storage/types.ts";

/** Snapshots kept per page for reverting Claude's changes. */
const SNAPSHOTS_KEPT = 20;

interface PageRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  ord: number;
  repo: string | null;
  by_claude: number;
  claude_change: string | null;
  queued: number;
}

interface ClaudeChange {
  at: number;
  snapshotId: number;
}

export interface SaveResult {
  meta: PageMeta;
  /** Referenced images the server doesn't have and the save didn't include. */
  missingFiles: string[];
}

export type EditResult = { ok: true; pageId: string; addedIds: string[] } | { ok: false; errors: string[] };

export interface ClaudePageView {
  meta: PageMeta;
  shapes: Shape[];
}

const META_COLUMNS = `p.id, p.name, p.created_at, p.updated_at, p.ord, p.repo, p.by_claude, p.claude_change,
  (SELECT count(*) FROM queue q WHERE q.page_id = p.id) AS queued`;

/**
 * All of Meadowlark's data, on SQLite. Used by the app server (for the
 * browser) and by the MCP server (for Claude), each with its own connection
 * to the same file. Every method is synchronous and every write is one
 * transaction.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  listPages(): PageMeta[] {
    return this.all<PageRow>(`SELECT ${META_COLUMNS} FROM pages p`).map(toMeta);
  }

  getPage(id: string): Page | null {
    const row = this.get<PageRow & { elements: string; app_state: string }>(
      `SELECT ${META_COLUMNS}, p.elements, p.app_state FROM pages p WHERE p.id = ?`,
      id,
    );
    if (!row) return null;
    const view = this.get<{ scroll_x: number; scroll_y: number; zoom: number }>(
      "SELECT scroll_x, scroll_y, zoom FROM views WHERE page_id = ?",
      id,
    );
    return {
      ...toMeta(row),
      elements: JSON.parse(row.elements) as ExcalidrawElement[],
      appState: JSON.parse(row.app_state) as PersistedAppState,
      files: this.pageFiles(id),
      view: view ? { scrollX: view.scroll_x, scrollY: view.scroll_y, zoom: view.zoom } : null,
    };
  }

  createPage(input: NewPageInput): PageMeta {
    return this.tx(() => this.insertPage(input));
  }

  savePageScene(id: string, scene: PageScene): SaveResult | null {
    return this.tx(() => {
      const row = this.metaRow(id);
      if (!row) return null; // deleted while a save was pending: don't resurrect it
      const elements = liveElements(scene.elements);
      const updatedAt = Math.max(this.now(), row.updated_at + 1);
      this.run(
        "UPDATE pages SET elements = ?, app_state = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(elements),
        JSON.stringify(scene.appState),
        updatedAt,
        id,
      );
      const missingFiles = this.syncFiles(id, elements, scene.files);
      return { meta: toMeta({ ...row, updated_at: updatedAt }), missingFiles };
    });
  }

  savePageView(id: string, view: PageView): void {
    this.run(
      `INSERT INTO views (page_id, scroll_x, scroll_y, zoom) SELECT id, ?, ?, ? FROM pages WHERE id = ?
       ON CONFLICT (page_id) DO UPDATE SET scroll_x = excluded.scroll_x, scroll_y = excluded.scroll_y, zoom = excluded.zoom`,
      view.scrollX,
      view.scrollY,
      view.zoom,
      id,
    );
  }

  updatePageMeta(id: string, patch: Partial<Pick<PageMeta, "name">>): PageMeta | null {
    return this.tx(() => {
      if (!this.metaRow(id)) return null;
      if (patch.name !== undefined) this.run("UPDATE pages SET name = ? WHERE id = ?", patch.name, id);
      this.run("UPDATE pages SET updated_at = ? WHERE id = ?", this.now(), id);
      return toMeta(this.metaRow(id)!);
    });
  }

  duplicatePage(id: string, name: string): PageMeta | null {
    return this.tx(() => {
      const source = this.getPage(id);
      if (!source) return null;
      const meta = this.insertPage({ ...source, name, repo: source.repo ?? null });
      if (source.view) this.savePageView(meta.id, source.view);
      return meta;
    });
  }

  deletePage(id: string): void {
    this.run("DELETE FROM pages WHERE id = ?", id);
  }

  putPages(pages: BackupPage[]): void {
    this.tx(() => {
      for (const page of pages) {
        const elements = liveElements(page.elements);
        this.run(
          `INSERT INTO pages (id, name, created_at, updated_at, ord, repo, by_claude, elements, app_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at,
             updated_at = excluded.updated_at, ord = excluded.ord, repo = COALESCE(excluded.repo, pages.repo),
             by_claude = MAX(excluded.by_claude, pages.by_claude), elements = excluded.elements, app_state = excluded.app_state, claude_change = NULL`,
          page.id,
          page.name,
          page.createdAt,
          page.updatedAt,
          page.order,
          page.repo ?? null,
          // Backups from before byClaude existed: only Claude's pages had a repo.
          Number(page.byClaude ?? page.repo != null),
          JSON.stringify(elements),
          JSON.stringify(page.appState),
        );
        // Drop the saved viewport so the restored page scrolls to its content.
        this.run("DELETE FROM views WHERE page_id = ?", page.id);
        this.run("DELETE FROM files WHERE page_id = ?", page.id);
        this.syncFiles(page.id, elements, page.files);
      }
    });
  }

  // ---- Claude ---------------------------------------------------------------

  /** Pages for Claude, most recently changed first, optionally filtered by name. */
  findPages(query?: string): (PageMeta & { elementCount: number })[] {
    const rows = this.all<PageRow & { element_count: number }>(
      `SELECT ${META_COLUMNS}, json_array_length(p.elements) AS element_count FROM pages p
       WHERE ? IS NULL OR p.name LIKE '%' || ? || '%' ORDER BY p.updated_at DESC`,
      query ?? null,
      query ?? null,
    );
    return rows.map((row) => ({ ...toMeta(row), elementCount: row.element_count }));
  }

  /** The page as Claude sees it, including edits the app hasn't applied yet. */
  readForClaude(id: string): ClaudePageView | null {
    const page = this.getPage(id);
    if (!page) return null;
    return { meta: stripScene(page), shapes: this.projectedShapes(id, page.elements) };
  }

  /** Queues an edit from Claude. The app applies it (or asks first, if the page is open). */
  queueEdit(id: string, edit: PageEdit): EditResult {
    return this.tx(() => {
      const page = this.getPage(id);
      if (!page) return { ok: false, errors: [`No page with id "${id}".`] };
      const shapes = this.projectedShapes(id, page.elements);
      return this.enqueue(id, shapes, edit);
    });
  }

  /** Creates a page whose content is drawn by the app from Claude's shapes. */
  addClaudePage(name: string, shapes: NewShape[], repo: string | null): EditResult {
    try {
      return this.tx(() => {
        const meta = this.insertPage({ name, repo, byClaude: true });
        const result = this.enqueue(meta.id, [], { add: shapes });
        if (!result.ok) throw new RejectedEdit(result.errors); // roll back the page
        return result;
      });
    } catch (err) {
      if (err instanceof RejectedEdit) return { ok: false, errors: err.errors };
      throw err;
    }
  }

  getQueuedEdits(id: string): QueuedEdit[] {
    return this.all<{ id: number; created_at: number; edit: string }>(
      "SELECT id, created_at, edit FROM queue WHERE page_id = ? ORDER BY id",
      id,
    ).map((row) => ({ id: row.id, createdAt: row.created_at, edit: JSON.parse(row.edit) as PageEdit }));
  }

  applyQueuedEdits(id: string, apply: ApplyQueuedEdits): PageMeta | "conflict" | null {
    return this.tx(() => {
      const row = this.metaRow(id);
      if (!row) return null;
      if (row.updated_at !== apply.baseUpdatedAt) return "conflict";
      const queued = new Set(this.getQueuedEdits(id).map((e) => e.id));
      if (apply.editIds.length === 0 || apply.editIds.some((e) => !queued.has(e))) return "conflict";

      const snapshotId = this.snapshot(id, "claude-edit");
      const elements = liveElements(apply.elements);
      const updatedAt = Math.max(this.now(), row.updated_at + 1);
      const change: ClaudeChange = { at: updatedAt, snapshotId };
      this.run(
        "UPDATE pages SET elements = ?, updated_at = ?, claude_change = ? WHERE id = ?",
        JSON.stringify(elements),
        updatedAt,
        JSON.stringify(change),
        id,
      );
      this.syncFiles(id, elements, {});
      for (const editId of apply.editIds) this.run("DELETE FROM queue WHERE id = ?", editId);
      return toMeta(this.metaRow(id)!);
    });
  }

  discardQueuedEdits(id: string): void {
    this.run("DELETE FROM queue WHERE page_id = ?", id);
  }

  /**
   * Undoes Claude's most recent change: drops the newest queued edit if there
   * is one, otherwise restores the page from before the last applied change.
   */
  revertLatestClaudeChange(id: string): "dropped-queued" | "reverted" | "nothing" | null {
    return this.tx(() => {
      if (!this.metaRow(id)) return null;
      const last = this.get<{ id: number }>("SELECT max(id) AS id FROM queue WHERE page_id = ?", id);
      if (last?.id != null) {
        this.run("DELETE FROM queue WHERE id = ?", last.id);
        return "dropped-queued";
      }
      return this.restoreClaudeSnapshot(id) ? "reverted" : "nothing";
    });
  }

  revertClaudeChange(id: string): PageMeta | null {
    return this.tx(() => (this.restoreClaudeSnapshot(id) ? toMeta(this.metaRow(id)!) : null));
  }

  dismissClaudeChange(id: string): void {
    this.run("UPDATE pages SET claude_change = NULL WHERE id = ?", id);
  }

  /** Copies the database to `path` in one consistent read, safe while others write. */
  backupTo(path: string): void {
    this.db.prepare("VACUUM INTO ?").run(path);
  }

  /** Changes whenever another connection commits a write. */
  dataVersion(): number {
    return this.get<{ data_version: number }>("PRAGMA data_version")!.data_version;
  }

  // ---- internals ------------------------------------------------------------

  private insertPage(input: NewPageInput): PageMeta {
    const { min } = this.get<{ min: number }>("SELECT COALESCE(MIN(ord), 0) AS min FROM pages")!;
    const now = this.now();
    const id = randomUUID();
    const elements = liveElements(input.elements ?? []);
    this.run(
      `INSERT INTO pages (id, name, created_at, updated_at, ord, repo, by_claude, elements, app_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      now,
      now,
      Math.min(min, 0) - 1,
      input.repo ?? null,
      Number(input.byClaude ?? false),
      JSON.stringify(elements),
      JSON.stringify(input.appState ?? {}),
    );
    this.syncFiles(id, elements, input.files ?? {});
    return toMeta(this.metaRow(id)!);
  }

  private enqueue(id: string, shapes: Shape[], edit: PageEdit): EditResult {
    const taken = new Set(shapes.map((s) => s.id));
    const prepared = prepareEdit(shapes, edit, () => {
      let next: string;
      do next = `c${randomBytes(5).toString("hex")}`;
      while (taken.has(next));
      taken.add(next);
      return next;
    });
    if (!prepared.edit) return { ok: false, errors: prepared.errors };
    this.run(
      "INSERT INTO queue (page_id, created_at, edit) VALUES (?, ?, ?)",
      id,
      this.now(),
      JSON.stringify(prepared.edit),
    );
    return { ok: true, pageId: id, addedIds: (prepared.edit.add ?? []).map((s) => s.id!) };
  }

  private projectedShapes(id: string, elements: readonly ExcalidrawElement[]): Shape[] {
    return projectEdits(
      toShapes(elements),
      this.getQueuedEdits(id).map((q) => q.edit),
    );
  }

  /** Saves the page's current content so it can be restored, keeping the newest few. */
  private snapshot(id: string, reason: string): number {
    const page = this.getPage(id)!;
    const result = this.run(
      "INSERT INTO snapshots (page_id, created_at, reason, elements, app_state, files) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      this.now(),
      reason,
      JSON.stringify(page.elements),
      JSON.stringify(page.appState),
      JSON.stringify(page.files),
    );
    this.run(
      `DELETE FROM snapshots WHERE page_id = ? AND id NOT IN
         (SELECT id FROM snapshots WHERE page_id = ? ORDER BY id DESC LIMIT ?)`,
      id,
      id,
      SNAPSHOTS_KEPT,
    );
    return Number(result.lastInsertRowid);
  }

  private restoreClaudeSnapshot(id: string): boolean {
    const row = this.metaRow(id);
    const change = row?.claude_change ? (JSON.parse(row.claude_change) as ClaudeChange) : null;
    if (!row || !change) return false;
    const snap = this.get<{ elements: string; app_state: string; files: string }>(
      "SELECT elements, app_state, files FROM snapshots WHERE id = ? AND page_id = ?",
      change.snapshotId,
      id,
    );
    if (!snap) return false;
    // So a revert can itself be undone by hand from the database if needed.
    this.snapshot(id, "before-revert");
    const elements = JSON.parse(snap.elements) as ExcalidrawElement[];
    this.run(
      "UPDATE pages SET elements = ?, app_state = ?, updated_at = ?, claude_change = NULL WHERE id = ?",
      snap.elements,
      snap.app_state,
      Math.max(this.now(), row.updated_at + 1),
      id,
    );
    this.syncFiles(id, elements, JSON.parse(snap.files) as BinaryFiles);
    return true;
  }

  /**
   * Makes the page's stored images match what its elements reference: prunes
   * unreferenced ones and stores new ones from `files`. Ids are content
   * hashes, so a stored image never needs rewriting.
   */
  private syncFiles(pageId: string, elements: readonly ExcalidrawElement[], files: BinaryFiles): string[] {
    const wanted = referencedFileIds(elements);
    const stored = new Set(
      this.all<{ file_id: string }>("SELECT file_id FROM files WHERE page_id = ?", pageId).map((r) => r.file_id),
    );
    for (const fileId of stored) {
      if (!wanted.has(fileId)) this.run("DELETE FROM files WHERE page_id = ? AND file_id = ?", pageId, fileId);
    }
    const missing: string[] = [];
    for (const fileId of wanted) {
      if (stored.has(fileId)) continue;
      const file = files[fileId];
      if (file) this.run("INSERT INTO files (page_id, file_id, data) VALUES (?, ?, ?)", pageId, fileId, JSON.stringify(file));
      else missing.push(fileId);
    }
    return missing;
  }

  private pageFiles(id: string): BinaryFiles {
    const files: BinaryFiles = {};
    for (const row of this.all<{ file_id: string; data: string }>("SELECT file_id, data FROM files WHERE page_id = ?", id)) {
      files[row.file_id] = JSON.parse(row.data) as BinaryFileData;
    }
    return files;
  }

  private metaRow(id: string): PageRow | undefined {
    return this.get<PageRow>(`SELECT ${META_COLUMNS} FROM pages p WHERE p.id = ?`, id);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
}

/** Rolls back a transaction that turned out to be invalid partway through. */
class RejectedEdit extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join(" "));
    this.errors = errors;
  }
}

function toMeta(row: PageRow): PageMeta {
  const change = row.claude_change ? (JSON.parse(row.claude_change) as ClaudeChange) : null;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    order: row.ord,
    repo: row.repo,
    byClaude: row.by_claude === 1,
    claude: { queued: row.queued, changedAt: change?.at ?? null },
  };
}

function stripScene(page: Page): PageMeta {
  const { elements: _e, appState: _a, files: _f, view: _v, ...meta } = page;
  return meta;
}
