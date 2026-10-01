import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { QueuedEdit } from "../claude/model.ts";

/** Lightweight page info. This is all the sidebar ever loads. */
export interface PageMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Position in backups (ascending). The sidebar sorts by updatedAt. */
  order: number;
  /** Repo a Claude session created this page from (git remote or path). Not shown yet. */
  repo?: string | null;
  /** Claude created this page (or the page it was duplicated from). */
  byClaude?: boolean;
  claude?: ClaudeStatus;
}

export interface ClaudeStatus {
  /** Edits from Claude waiting for the app to apply them. */
  queued: number;
  /** When Claude last changed this page, until it's reverted or dismissed. */
  changedAt: number | null;
}

export interface ApplyQueuedEdits {
  editIds: number[];
  /** The page's elements with the edits applied. */
  elements: readonly ExcalidrawElement[];
  /** updatedAt of the page the edits were applied to. The apply fails if the page changed since. */
  baseUpdatedAt: number;
}

/**
 * The subset of Excalidraw's appState that belongs to a page's content.
 * Everything else (selection, open menus, collaborators, tool state, theme)
 * is transient or app-wide and is never persisted per page.
 */
export interface PersistedAppState {
  viewBackgroundColor?: AppState["viewBackgroundColor"];
  gridSize?: AppState["gridSize"];
  gridStep?: AppState["gridStep"];
  gridModeEnabled?: AppState["gridModeEnabled"];
}

/** Where the user was looking. Saved separately so panning doesn't rewrite the scene. */
export interface PageView {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface PageScene {
  elements: readonly ExcalidrawElement[];
  appState: PersistedAppState;
  files: BinaryFiles;
}

export interface Page extends PageMeta, PageScene {
  /** Null if this page has never been viewed/panned (e.g. freshly imported). */
  view: PageView | null;
}

export interface NewPageInput {
  name: string;
  repo?: string | null;
  byClaude?: boolean;
  elements?: readonly ExcalidrawElement[];
  appState?: PersistedAppState;
  files?: BinaryFiles;
}

export interface BackupPage extends PageMeta, PageScene {}

export interface Backup {
  type: "meadowlark-backup";
  version: 1;
  exportedAt: number;
  pages: BackupPage[];
}

/**
 * All persistence goes through this interface. The browser implements it
 * over HTTP (storage/http.ts); the server implements it on SQLite.
 */
export interface StorageAdapter {
  listPages(): Promise<PageMeta[]>;
  getPage(id: string): Promise<Page | null>;
  createPage(input: NewPageInput): Promise<PageMeta>;
  /** Replace a page's scene. Bumps updatedAt. Returns null if the page no longer exists. */
  savePageScene(id: string, scene: PageScene): Promise<PageMeta | null>;
  /** Save viewport only. Does not bump updatedAt. */
  savePageView(id: string, view: PageView): Promise<void>;
  updatePageMeta(id: string, patch: Partial<Pick<PageMeta, "name">>): Promise<PageMeta | null>;
  duplicatePage(id: string, name: string): Promise<PageMeta | null>;
  deletePage(id: string): Promise<void>;
  /** Insert or overwrite pages by id. Pages not in the list are untouched. */
  putPages(pages: BackupPage[]): Promise<void>;

  /** Claude's edits for a page that haven't been applied yet, oldest first. */
  getQueuedEdits(id: string): Promise<QueuedEdit[]>;
  /**
   * Saves the result of applying queued edits, snapshotting the page first so
   * the change can be reverted. "conflict" if the page or its queue changed
   * since it was read; null if the page is gone.
   */
  applyQueuedEdits(id: string, apply: ApplyQueuedEdits): Promise<PageMeta | "conflict" | null>;
  discardQueuedEdits(id: string): Promise<void>;
  /** Puts the page back to how it was before Claude's last applied change. */
  revertClaudeChange(id: string): Promise<PageMeta | null>;
  /** Keeps Claude's last change and stops flagging it. */
  dismissClaudeChange(id: string): Promise<void>;
}
