import type { StorageAdapter } from "./types";

/**
 * Wraps an adapter so every call runs strictly in the order it was made.
 *
 * This is what makes fast page switching safe: the outgoing page's final save
 * is enqueued synchronously before the incoming page's load, so a load can
 * never observe a state older than a save that was requested before it.
 *
 * When nothing is queued, a call starts synchronously rather than on a later
 * microtask, so a save requested from beforeunload can begin its transaction
 * while the page is still allowed to.
 */
export function serialized(inner: StorageAdapter): StorageAdapter {
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const start = () => {
      try {
        return fn();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const result = queued === 0 ? start() : tail.then(start, start);
    queued++;
    tail = result.then(
      () => void queued--,
      () => void queued--,
    );
    return result;
  };
  return {
    listPages: () => run(() => inner.listPages()),
    getPage: (id) => run(() => inner.getPage(id)),
    createPage: (input) => run(() => inner.createPage(input)),
    savePageScene: (id, scene) => run(() => inner.savePageScene(id, scene)),
    savePageView: (id, view) => run(() => inner.savePageView(id, view)),
    updatePageMeta: (id, patch) => run(() => inner.updatePageMeta(id, patch)),
    setPagePinned: (id, pinned) => run(() => inner.setPagePinned(id, pinned)),
    keepPage: (id) => run(() => inner.keepPage(id)),
    setPageSaved: (id, saved) => run(() => inner.setPageSaved(id, saved)),
    duplicatePage: (id, name) => run(() => inner.duplicatePage(id, name)),
    deletePage: (id) => run(() => inner.deletePage(id)),
    putPages: (pages) => run(() => inner.putPages(pages)),
    getQueuedEdits: (id) => run(() => inner.getQueuedEdits(id)),
    applyQueuedEdits: (id, apply) => run(() => inner.applyQueuedEdits(id, apply)),
    discardQueuedEdits: (id) => run(() => inner.discardQueuedEdits(id)),
    revertClaudeChange: (id) => run(() => inner.revertClaudeChange(id)),
    dismissClaudeChange: (id) => run(() => inner.dismissClaudeChange(id)),
  };
}
