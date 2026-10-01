import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

let seq = 0;

export function rect(overrides: Partial<Record<string, unknown>> = {}): ExcalidrawElement {
  seq++;
  return { id: `el-${seq}`, type: "rectangle", version: 1, versionNonce: seq, isDeleted: false, ...overrides } as unknown as ExcalidrawElement;
}

export function image(fileId: string, overrides: Partial<Record<string, unknown>> = {}): ExcalidrawElement {
  return rect({ type: "image", fileId, ...overrides });
}

export function file(id: string): BinaryFileData {
  return { id, mimeType: "image/png", dataURL: `data:image/png;base64,${id}`, created: 1 } as BinaryFileData;
}

export function files(...ids: string[]): BinaryFiles {
  return Object.fromEntries(ids.map((id) => [id, file(id)]));
}

export function appState(overrides: Partial<AppState> = {}): AppState {
  return {
    viewBackgroundColor: "#ffffff",
    gridSize: 20,
    gridStep: 5,
    gridModeEnabled: false,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    theme: "light",
    ...overrides,
  } as AppState;
}

/** Sum of versions, like Excalidraw's scene version. Good enough for tests. */
export function hashElements(elements: readonly ExcalidrawElement[]): number {
  return elements.reduce((sum, el) => sum * 31 + el.version + (el.isDeleted ? 7 : 0), elements.length);
}
