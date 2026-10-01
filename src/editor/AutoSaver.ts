import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { pickPersistedAppState, pickView, referencedFileIds } from "../storage/scene";
import type { PageMeta, StorageAdapter } from "../storage/types";

const MAX_RETRIES = 5;

export type SaveStatus = "saved" | "saving" | "error";

export interface SceneSnapshot {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}

export interface AutoSaverOptions {
  pageId: string;
  storage: StorageAdapter;
  /** Cheap content hash of elements (Excalidraw's hashElementsVersion). Injected to keep this testable. */
  hashElements: (elements: readonly ExcalidrawElement[]) => number;
  /** The scene as loaded, so opening a page without editing it doesn't count as a change. */
  baseline: SceneSnapshot;
  delayMs?: number;
  /** Upper bound on how long continuous editing can postpone a save. */
  maxWaitMs?: number;
  retryMs?: number;
  onSaved?: (meta: PageMeta) => void;
  onStatus?: (status: SaveStatus, error?: unknown) => void;
}

/**
 * Debounced saver for one page. Excalidraw calls onChange for everything
 * (pointer moves, selection, scrolling), so schedule() only records the latest
 * snapshot; the real work (hashing, diffing, writing) happens once per flush.
 *
 * Content changes bump updatedAt; viewport-only changes are saved separately
 * so panning around doesn't reorder the "recent" list.
 */
export class AutoSaver {
  private readonly opts: Required<Omit<AutoSaverOptions, "onSaved" | "onStatus">> &
    Pick<AutoSaverOptions, "onSaved" | "onStatus">;
  private latest: SceneSnapshot | null = null;
  private savedContentKey: string | null;
  private savedViewKey: string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSince: number | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private disposed = false;
  private failures = 0;
  private writesInFlight = 0;
  private sceneWritesInFlight = 0;
  private status: SaveStatus = "saved";

  constructor(options: AutoSaverOptions) {
    this.opts = { delayMs: 500, maxWaitMs: 5000, retryMs: 3000, ...options };
    this.savedContentKey = this.contentKey(options.baseline);
    this.savedViewKey = viewKey(options.baseline.appState);
  }

  schedule(snapshot: SceneSnapshot): void {
    if (this.disposed) return;
    // No status change here: most onChange calls (pointer moves, selection)
    // aren't edits, and we only find out at flush time.
    this.latest = snapshot;
    const now = Date.now();
    this.pendingSince ??= now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.opts.delayMs, this.pendingSince + this.opts.maxWaitMs - now));
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  /** Write any pending changes now. Resolves once they (and earlier writes) are persisted. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingSince = null;
    const snapshot = this.latest;
    this.latest = null;
    if (!snapshot) return this.inflight;

    const { pageId, storage } = this.opts;
    const contentKey = this.contentKey(snapshot);
    const nextViewKey = viewKey(snapshot.appState);
    const writes: Promise<unknown>[] = [];

    if (contentKey !== this.savedContentKey) {
      this.savedContentKey = contentKey;
      // The storage call is made synchronously so it is ordered before any
      // later read (see storage/serialized.ts).
      this.sceneWritesInFlight++;
      writes.push(
        storage
          .savePageScene(pageId, {
            elements: snapshot.elements,
            appState: pickPersistedAppState(snapshot.appState),
            files: snapshot.files,
          })
          .then((meta) => {
            if (meta) this.opts.onSaved?.(meta);
          })
          .finally(() => this.sceneWritesInFlight--),
      );
    }
    if (nextViewKey !== this.savedViewKey) {
      this.savedViewKey = nextViewKey;
      writes.push(storage.savePageView(pageId, pickView(snapshot.appState)));
    }
    if (writes.length === 0) return this.inflight;

    this.setStatus("saving");
    this.writesInFlight++;
    const run = Promise.all(writes).then(
      () => {
        this.failures = 0;
        if (--this.writesInFlight === 0) this.setStatus("saved");
      },
      (error: unknown) => {
        this.writesInFlight--;
        console.error(`Failed to save page ${pageId}`, error);
        this.failures++;
        this.setStatus("error", error);
        // Force the next flush to rewrite everything, and retry on our own
        // (even after dispose, so a failed final save on page switch isn't dropped).
        this.savedContentKey = null;
        this.savedViewKey = null;
        if (!this.latest) this.latest = snapshot;
        if (this.failures <= MAX_RETRIES && !this.timer) {
          this.timer = setTimeout(() => void this.flush(), this.opts.retryMs);
        }
      },
    );
    this.inflight = this.inflight.then(() => run);
    return this.inflight;
  }

  /** Flush and stop accepting changes. */
  dispose(): Promise<void> {
    const done = this.flush();
    this.disposed = true;
    return done;
  }

  /** Drop pending changes and stop accepting new ones (the page is being replaced underneath us). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
    this.disposed = true;
    this.failures = MAX_RETRIES + 1;
  }

  /** True while page content is being written (including a write just started by flush()). Viewport-only writes don't count. */
  get isSavingContent(): boolean {
    return this.sceneWritesInFlight > 0;
  }

  private setStatus(status: SaveStatus, error?: unknown): void {
    if (status === this.status && status !== "error") return;
    this.status = status;
    this.opts.onStatus?.(status, error);
  }

  private contentKey(snapshot: SceneSnapshot): string {
    const { appState, elements, files } = snapshot;
    // Count referenced images whose data is available, so an image that
    // finishes loading after its element was created still triggers a save.
    let loadedFiles = 0;
    for (const id of referencedFileIds(elements)) if (files[id]) loadedFiles++;
    return [
      this.opts.hashElements(elements),
      loadedFiles,
      appState.viewBackgroundColor,
      appState.gridSize,
      appState.gridStep,
      appState.gridModeEnabled,
    ].join("|");
  }
}

function viewKey(appState: Pick<AppState, "scrollX" | "scrollY" | "zoom">): string {
  return `${appState.scrollX}|${appState.scrollY}|${appState.zoom.value}`;
}
