import { loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import { pickPersistedAppState } from "../storage/scene";
import type { NewPageInput, Page } from "../storage/types";

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "untitled";
}

export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportPageBlob(page: Page): Blob {
  const json = serializeAsJSON(page.elements, page.appState, page.files, "local");
  return new Blob([json], { type: "application/vnd.excalidraw+json" });
}

/** Parses a .excalidraw (or Excalidraw-embedded PNG/SVG) file into a new page. */
export async function readExcalidrawFile(file: File): Promise<NewPageInput> {
  const scene = await loadFromBlob(file, null, null);
  return {
    name: file.name.replace(/(\.excalidraw)?\.(excalidraw|json|png|svg)$/i, "") || "Imported",
    elements: scene.elements,
    appState: pickPersistedAppState(scene.appState),
    files: scene.files,
  };
}
