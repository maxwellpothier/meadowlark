import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { PageView, PersistedAppState } from "./types.ts";

// Pure helpers shared by storage and editor code. Deliberately free of
// runtime imports from @excalidraw/excalidraw so storage stays testable in Node.

export function pickPersistedAppState(appState: Partial<AppState> | null | undefined): PersistedAppState {
  if (!appState) return {};
  const out: PersistedAppState = {};
  if (typeof appState.viewBackgroundColor === "string") out.viewBackgroundColor = appState.viewBackgroundColor;
  if (typeof appState.gridSize === "number") out.gridSize = appState.gridSize;
  if (typeof appState.gridStep === "number") out.gridStep = appState.gridStep;
  if (typeof appState.gridModeEnabled === "boolean") out.gridModeEnabled = appState.gridModeEnabled;
  return out;
}

export function pickView(appState: Pick<AppState, "scrollX" | "scrollY" | "zoom">): PageView {
  return { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value };
}

export function liveElements(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.filter((el) => !el.isDeleted);
}

/** File ids referenced by non-deleted image elements. */
export function referencedFileIds(elements: readonly ExcalidrawElement[]): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.type === "image" && !el.isDeleted && el.fileId) ids.add(el.fileId);
  }
  return ids;
}
