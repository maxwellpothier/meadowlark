import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Excalidraw, getVisibleSceneBounds, hashElementsVersion, restore } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { ThemeName } from "../prefs";
import type { PageMeta, SceneRect, StorageAdapter } from "../storage/types";
import { fitText } from "../claude/apply";
import { AutoSaver, type SaveStatus } from "./AutoSaver";

interface EditorProps {
  pageId: string;
  pageName: string;
  storage: StorageAdapter;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onSaved: (meta: PageMeta) => void;
  /** Called with the page's updatedAt once it has loaded. */
  onLoaded: (id: string, updatedAt: number) => void;
  onStatus: (status: SaveStatus) => void;
  /** Called on every change with what's selected (a selected label counts as its box) and the part of the page on screen. */
  onViewerChange: (selectedIds: string[], viewport: SceneRect) => void;
  /** Lets the parent flush pending edits (before switching pages, exporting, etc.). */
  saverRef: RefObject<AutoSaver | null>;
}

interface Loaded {
  pageId: string;
  initialData: ExcalidrawInitialDataState;
  baseline: { elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles };
}

const UI_OPTIONS = {
  canvasActions: {
    // Needed because we control `theme`; otherwise Excalidraw hides its toggle.
    toggleTheme: true,
  },
};

export function Editor(props: EditorProps) {
  const { pageId, pageName, storage, theme, onThemeChange, onSaved, onLoaded, onStatus, onViewerChange, saverRef } = props;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Callbacks change identity on every App render; keep the latest in refs so
  // the saver and onChange handler don't need to be recreated.
  const callbacks = useRef({ onThemeChange, onSaved, onLoaded, onStatus, onViewerChange, theme });
  useLayoutEffect(() => {
    callbacks.current = { onThemeChange, onSaved, onLoaded, onStatus, onViewerChange, theme };
  });
  // Excalidraw may report its default theme before it has applied our prop.
  // Only treat a mismatch as the user's toggle once it has reported ours.
  const themeApplied = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const page = await storage.getPage(pageId);
      if (!page) return { page, fitted: [] };
      return { page, fitted: await fitText(page.elements) };
    };
    load().then(
      ({ page, fitted }) => {
        if (cancelled) return;
        if (!page) {
          setError("This page no longer exists.");
          return;
        }
        callbacks.current.onLoaded(page.id, page.updatedAt);
        const appState: Partial<AppState> = { ...page.appState };
        if (page.view) {
          appState.scrollX = page.view.scrollX;
          appState.scrollY = page.view.scrollY;
          appState.zoom = { value: page.view.zoom as AppState["zoom"]["value"] };
        }
        // Restore up front (Excalidraw would do it anyway) so the saver's
        // baseline matches what the editor will actually report.
        const restored = restore({ elements: page.elements, appState, files: page.files }, null, null);
        // Text that fitText re-sized differs from the baseline, so the saver writes the fix.
        const elements = fitted === page.elements ? restored.elements : restore({ elements: fitted }, null, null).elements;
        setLoaded({
          pageId,
          initialData: {
            elements,
            appState: { ...appState },
            files: restored.files,
            scrollToContent: !page.view,
          },
          baseline: {
            elements: restored.elements,
            appState: restored.appState as AppState,
            files: restored.files,
          },
        });
      },
      (err: unknown) => {
        if (!cancelled) setError(`Couldn't load page: ${String(err)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pageId, storage]);

  const ready = loaded?.pageId === pageId ? loaded : null;

  useEffect(() => {
    if (!ready) return;
    const saver = new AutoSaver({
      pageId: ready.pageId,
      storage,
      hashElements: hashElementsVersion,
      baseline: ready.baseline,
      onSaved: (meta) => callbacks.current.onSaved(meta),
      onStatus: (status) => callbacks.current.onStatus(status),
    });
    saverRef.current = saver;
    themeApplied.current = false;
    return () => {
      void saver.dispose();
      if (saverRef.current === saver) saverRef.current = null;
    };
  }, [ready, storage, saverRef]);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      if (appState.theme === callbacks.current.theme) themeApplied.current = true;
      else if (themeApplied.current) callbacks.current.onThemeChange(appState.theme);
      saverRef.current?.schedule({ elements, appState, files });
      callbacks.current.onViewerChange(selectedIds(elements, appState), visibleRect(appState));
    },
    [saverRef],
  );

  if (error) return <div className="editor-message">{error}</div>;
  if (!ready) return <div className="editor-message">Loading…</div>;

  return (
    <Excalidraw
      key={ready.pageId}
      initialData={ready.initialData}
      onChange={handleChange}
      theme={theme}
      name={pageName}
      UIOptions={UI_OPTIONS}
      autoFocus
    />
  );
}

function selectedIds(elements: readonly ExcalidrawElement[], appState: AppState): string[] {
  const ids = Object.keys(appState.selectedElementIds);
  if (ids.length === 0) return ids;
  const containers = new Map<string, string>();
  for (const el of elements) if (el.type === "text" && el.containerId) containers.set(el.id, el.containerId);
  return [...new Set(ids.map((id) => containers.get(id) ?? id))].sort();
}

function visibleRect(appState: AppState): SceneRect {
  const [minX, minY, maxX, maxY] = getVisibleSceneBounds(appState).map(Math.round);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
