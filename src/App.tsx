import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyEdits } from "./claude/apply";
import type { AutoSaver, SaveStatus } from "./editor/AutoSaver";
import { Editor } from "./editor/Editor";
import { buildBackupBlob, parseBackup } from "./io/backup";
import { downloadFile, exportPageBlob, pickFiles, readExcalidrawFile, safeFilename } from "./io/files";
import { isNarrowScreen, loadPrefs, savePrefs, type ThemeName } from "./prefs";
import { Sidebar, type SidebarActions } from "./sidebar/Sidebar";
import { sortPages } from "./sidebar/sort";
import { storage } from "./storage";
import type { PageMeta } from "./storage/types";
import { ClaudeBanner, type ClaudeBannerActions } from "./ui/ClaudeBanner";
import { useDialogs } from "./ui/useDialogs";

const EXCALIDRAW_ACCEPT = ".excalidraw,.json,application/json,application/vnd.excalidraw+json";

// Runs once per page load (not once per StrictMode effect run), so a fresh
// install never ends up with two "Untitled" pages.
let initialPages: Promise<PageMeta[]> | null = null;
function loadInitialPages(): Promise<PageMeta[]> {
  initialPages ??= storage.listPages().then(async (pages) => {
    if (pages.length > 0) return pages;
    return [await storage.createPage({ name: "Untitled" })];
  });
  return initialPages;
}

function nextUntitledName(pages: PageMeta[]): string {
  const names = new Set(pages.map((p) => p.name));
  if (!names.has("Untitled")) return "Untitled";
  let n = 2;
  while (names.has(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

export default function App() {
  const [prefs] = useState(loadPrefs);
  const [pages, setPages] = useState<PageMeta[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeName>(prefs.theme);
  const [collapsed, setCollapsed] = useState(() => isNarrowScreen() || prefs.sidebarCollapsed);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [fatal, setFatal] = useState<string | null>(null);
  // Bumped to force the editor to reload the active page from storage (after a restore).
  const [editorEpoch, setEditorEpoch] = useState(0);
  const saverRef = useRef<AutoSaver | null>(null);
  // The open page's updatedAt as this tab last loaded or saved it. A newer one
  // in the page list means something else changed it (Claude reverting, another tab).
  const knownRef = useRef<{ id: string; updatedAt: number } | null>(null);
  // Pages whose queued Claude edits are being applied, or failed to apply (by queue state).
  const applyingRef = useRef(new Set<string>());
  const failedRef = useRef(new Set<string>());
  // Queue state of the open page we last checked, so it isn't re-read on every refresh.
  const askedRef = useRef<string | null>(null);
  const [claudeBusy, setClaudeBusy] = useState(false);
  const dialogs = useDialogs();

  useEffect(() => {
    loadInitialPages().then(
      (list) => {
        setPages(list);
        const last = list.find((p) => p.id === prefs.lastActivePageId);
        setActiveId(last?.id ?? sortPages(list)[0].id);
      },
      (err: unknown) =>
        setFatal(`Couldn't reach the Meadowlark server (${String(err)}). Start it with npm start or npm run dev.`),
    );
  }, [prefs]);

  useEffect(() => {
    if (activeId) savePrefs({ lastActivePageId: activeId });
  }, [activeId]);
  useEffect(() => savePrefs({ theme, sidebarCollapsed: collapsed }), [theme, collapsed]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Last-chance save when the tab is hidden, reloaded or closed. beforeunload
  // is the one that counts: a request started there survives the page going
  // away only if it's a small keepalive fetch (see storage/http.ts). If
  // content is still being written, ask the browser to confirm leaving, which
  // gives the write time to land. In practice this only shows up if you
  // reload/close within about half a second of an edit.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const saver = saverRef.current;
      if (!saver) return;
      void saver.flush();
      if (saver.isSavingContent) e.preventDefault();
    };
    const onHidden = () => document.visibilityState === "hidden" && void saverRef.current?.flush();
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  const flushActive = useCallback(() => saverRef.current?.flush() ?? Promise.resolve(), []);

  const addMeta = useCallback((meta: PageMeta) => setPages((ps) => [...(ps ?? []), meta]), []);
  // Only touches pages we still have, so a late save can't resurrect a deleted page in the list.
  const updateMeta = useCallback((meta: PageMeta) => {
    if (knownRef.current?.id === meta.id) knownRef.current = { id: meta.id, updatedAt: meta.updatedAt };
    setPages((ps) => ps?.map((p) => (p.id === meta.id ? meta : p)) ?? ps);
  }, []);
  const onEditorLoaded = useCallback((id: string, updatedAt: number) => (knownRef.current = { id, updatedAt }), []);

  /** Reloads the open page from storage, dropping anything not yet saved. */
  const reloadEditor = useCallback(() => {
    saverRef.current?.cancel();
    setEditorEpoch((n) => n + 1);
  }, []);

  // The server pushes an event whenever the data changes, including when a
  // Claude session writes to it directly. Re-read the page list each time.
  useEffect(() => {
    let stale = false;
    const source = new EventSource("/api/events");
    source.onmessage = () => {
      void storage.listPages().then(
        (list) => {
          if (stale || list.length === 0) return;
          setPages(list);
          const known = knownRef.current;
          const open = known && list.find((p) => p.id === known.id);
          if (open && open.updatedAt > known.updatedAt && !applyingRef.current.has(open.id)) {
            knownRef.current = { id: open.id, updatedAt: open.updatedAt };
            reloadEditor();
          }
          setActiveId((id) => (id && list.some((p) => p.id === id) ? id : sortPages(list)[0].id));
        },
        (err: unknown) => console.error("Couldn't refresh pages", err),
      );
    };
    return () => {
      stale = true;
      source.close();
    };
  }, [reloadEditor]);

  /**
   * Draws Claude's queued edits into a page and saves the result (the server
   * snapshots the page first, for Revert). For the open page this replaces
   * the editor's content, so it only happens when asked or when the page is empty.
   */
  const applyQueued = useCallback(
    async (id: string, open: { askFirst: boolean } | null): Promise<void> => {
      if (applyingRef.current.has(id)) return;
      applyingRef.current.add(id);
      let failureKey: string | null = null;
      try {
        // Cheap check before flushing: an open page with content waits for the banner.
        if (open?.askFirst && (await storage.getPage(id))?.elements.some((el) => !el.isDeleted)) return;
        if (open) await flushActive();
        const [page, queued] = await Promise.all([storage.getPage(id), storage.getQueuedEdits(id)]);
        if (!page || queued.length === 0) return;
        failureKey = `${id}:${queued.map((q) => q.id).join(",")}`;
        if (failedRef.current.has(failureKey)) return;
        if (open?.askFirst && page.elements.some((el) => !el.isDeleted)) return;
        const elements = await applyEdits(
          page.elements,
          queued.map((q) => q.edit),
        );
        if (open) saverRef.current?.cancel();
        const result = await storage.applyQueuedEdits(id, {
          editIds: queued.map((q) => q.id),
          elements,
          baseUpdatedAt: page.updatedAt,
        });
        if (result && result !== "conflict") updateMeta(result);
        if (open) setEditorEpoch((n) => n + 1);
      } catch (err) {
        console.error(`Couldn't apply Claude's changes to page ${id}`, err);
        if (failureKey) failedRef.current.add(failureKey);
        if (open && !open.askFirst) {
          await dialogs.notify("Couldn't apply Claude's changes", err instanceof Error ? err.message : String(err));
        }
      } finally {
        applyingRef.current.delete(id);
      }
    },
    [flushActive, updateMeta, dialogs],
  );

  // Claude's edits to pages you aren't looking at apply straight away. The
  // open page waits for you (see ClaudeBanner), unless it's still empty.
  useEffect(() => {
    for (const page of pages ?? []) {
      const queued = page.claude?.queued ?? 0;
      if (!queued) continue;
      if (page.id !== activeId) {
        void applyQueued(page.id, null);
        continue;
      }
      const key = `${page.id}:${queued}`;
      if (askedRef.current === key) continue;
      askedRef.current = key;
      void applyQueued(page.id, { askFirst: true });
    }
  }, [pages, activeId, applyQueued]);

  const selectPage = useCallback(
    async (id: string) => {
      // Not strictly required (storage is serialized and the editor flushes on
      // unmount), but it makes "nothing is lost on switch" explicit.
      await flushActive();
      setActiveId(id);
      // On a phone the sidebar covers the canvas, so get it out of the way.
      if (isNarrowScreen()) setCollapsed(true);
    },
    [flushActive],
  );

  // Rebuilt every render, so these close over current state; useStableActions
  // gives the sidebar stable identities that always call the latest version.
  const handlers: SidebarActions = {
    onSelect: (id) => void selectPage(id),

    onCreate: async () => {
      const meta = await storage.createPage({ name: nextUntitledName(pages ?? []) });
      addMeta(meta);
      await selectPage(meta.id);
    },

    onRename: async (id, name) => {
      setPages((ps) => ps?.map((p) => (p.id === id ? { ...p, name } : p)) ?? ps);
      const meta = await storage.updatePageMeta(id, { name });
      if (meta) updateMeta(meta);
    },

    onDuplicate: async (id) => {
      const source = pages?.find((p) => p.id === id);
      if (!source) return;
      if (id === activeId) await flushActive();
      const meta = await storage.duplicatePage(id, `${source.name} copy`);
      if (!meta) return;
      addMeta(meta);
      await selectPage(meta.id);
    },

    onDelete: async (id) => {
      const list = pages ?? [];
      const page = list.find((p) => p.id === id);
      if (!page) return;
      const ok = await dialogs.confirm({
        title: `Delete "${page.name}"?`,
        message: "The page and its images are removed from Meadowlark. This can't be undone.",
        confirmLabel: "Delete page",
        danger: true,
      });
      if (!ok) return;
      const sorted = sortPages(list);
      const index = sorted.findIndex((p) => p.id === id);
      const remaining = sorted.filter((p) => p.id !== id);
      await storage.deletePage(id);
      if (remaining.length === 0) {
        const meta = await storage.createPage({ name: "Untitled" });
        setPages([meta]);
        setActiveId(meta.id);
        return;
      }
      setPages((ps) => ps?.filter((p) => p.id !== id) ?? ps);
      if (activeId === id) setActiveId(remaining[Math.min(index, remaining.length - 1)].id);
    },

    onExport: async (id) => {
      if (id === activeId) await flushActive();
      const page = await storage.getPage(id);
      if (page) await offerFile(exportPageBlob(page), `${safeFilename(page.name)}.excalidraw`);
    },

    onImport: async () => {
      const files = await pickFiles(EXCALIDRAW_ACCEPT, true);
      let lastId: string | null = null;
      const failures: string[] = [];
      for (const file of files) {
        try {
          const meta = await storage.createPage(await readExcalidrawFile(file));
          addMeta(meta);
          lastId = meta.id;
        } catch (err) {
          console.error(`Import failed for ${file.name}`, err);
          failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (lastId) await selectPage(lastId);
      if (failures.length) {
        await dialogs.notify(
          failures.length === files.length ? "Import failed" : "Some files weren't imported",
          <ul className="dialog-list">
            {failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>,
        );
      }
    },

    onExportAll: async () => {
      await flushActive();
      const { blob } = await buildBackupBlob(storage);
      const date = new Date().toISOString().slice(0, 10);
      await offerFile(blob, `meadowlark-backup-${date}.json`);
    },

    onRestore: async () => {
      const [file] = await pickFiles(".json,application/json");
      if (!file) return;
      let restored;
      try {
        restored = await parseBackup(file);
      } catch (err) {
        await dialogs.notify("Couldn't read that backup", err instanceof Error ? err.message : String(err));
        return;
      }
      const existing = new Set((pages ?? []).map((p) => p.id));
      const overwrites = restored.filter((p) => existing.has(p.id)).length;
      const ok = await dialogs.confirm({
        title: `Restore ${restored.length} ${restored.length === 1 ? "page" : "pages"}?`,
        message:
          (overwrites
            ? `${overwrites} ${overwrites === 1 ? "page" : "pages"} already here will be replaced by the backup version. `
            : "") + "Pages that aren't in the backup are kept.",
        confirmLabel: "Restore",
        danger: overwrites > 0,
      });
      if (!ok) return;

      // The open page may be about to be replaced. Save what's there, then stop
      // the editor from writing its (now stale) copy back over the restore.
      await flushActive();
      saverRef.current?.cancel();
      await storage.putPages(restored);
      const list = await storage.listPages();
      setPages(list);
      if (!list.some((p) => p.id === activeId)) setActiveId(sortPages(list)[0]?.id ?? null);
      setEditorEpoch((n) => n + 1);
    },

    onToggleCollapsed: () => setCollapsed((c) => !c),
  };
  const actions = useStableActions(handlers);

  async function offerFile(blob: Blob, filename: string) {
    downloadFile(blob, filename);
  }

  const activePage = pages?.find((p) => p.id === activeId) ?? null;

  const claudeActions: ClaudeBannerActions = {
    onApply: () => {
      if (!activeId) return;
      setClaudeBusy(true);
      void applyQueued(activeId, { askFirst: false }).finally(() => setClaudeBusy(false));
    },
    onDiscard: () => {
      if (!activeId) return;
      setClaudeBusy(true);
      void storage.discardQueuedEdits(activeId).finally(() => setClaudeBusy(false));
    },
    onRevert: async () => {
      if (!activeId) return;
      setClaudeBusy(true);
      try {
        // Saving first means the revert snapshot of "before revert" includes your latest edits.
        await flushActive();
        saverRef.current?.cancel();
        const meta = await storage.revertClaudeChange(activeId);
        if (meta) updateMeta(meta);
        setEditorEpoch((n) => n + 1);
      } finally {
        setClaudeBusy(false);
      }
    },
    onKeep: () => {
      if (!activeId) return;
      setClaudeBusy(true);
      void storage.dismissClaudeChange(activeId).finally(() => setClaudeBusy(false));
    },
  };

  if (fatal) return <div className="editor-message">{fatal}</div>;

  return (
    <div className="app" data-theme={theme}>
      {pages && (
        <Sidebar
          pages={pages}
          activeId={activeId}
          collapsed={collapsed}
          status={status}
          actions={actions}
        />
      )}
      <main className="editor">
        {activePage ? (
          <Editor
            key={`${activePage.id}:${editorEpoch}`}
            pageId={activePage.id}
            pageName={activePage.name}
            storage={storage}
            theme={theme}
            onThemeChange={setTheme}
            onSaved={updateMeta}
            onLoaded={onEditorLoaded}
            onStatus={setStatus}
            saverRef={saverRef}
          />
        ) : (
          <div className="editor-message">Loading…</div>
        )}
        {activePage && <ClaudeBanner page={activePage} busy={claudeBusy} actions={claudeActions} />}
      </main>
      {dialogs.element}
    </div>
  );
}

/** Returns an object with the same keys whose functions never change identity but always call the latest impl. */
function useStableActions<T extends object>(impl: T): T {
  const ref = useRef(impl);
  useLayoutEffect(() => {
    ref.current = impl;
  });
  const [stable] = useState(() => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(impl)) {
      out[key] = (...args: unknown[]) => (ref.current[key as keyof T] as (...a: unknown[]) => unknown)(...args);
    }
    return out as T;
  });
  return stable;
}
