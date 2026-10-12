import { convertToExcalidrawElements, exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, ExcalidrawFrameLikeElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { Page, RenderRequest, RenderResult, StorageAdapter } from "../storage/types";
import { applyEdits } from "./apply";
import type { PageEdit } from "./model";

// Draws pages for Claude (MCP render_page), so it can check its own layout.
// The MCP server can't draw: like applying edits, it needs a browser to
// measure text. So it leaves a request in the database, and whichever open
// tab claims it first draws the page and sends back a PNG.

/** Longest side of the picture. Bigger costs Claude more to look at without showing it more. */
const MAX_SIDE = 1600;
/** Small pages and crops are drawn larger than life, up to this, so their text stays readable. */
const MAX_SCALE = 2;
const PADDING = 20;
const CROP_MARGIN = 60;

/**
 * Returns a function that answers Claude's waiting render requests, one at a
 * time, until there are none. Call it whenever the data changes; calls made
 * while it's already working make it look again when it's done.
 * `beforeRender` runs first each time (the app saves the open page, so the
 * picture includes your latest strokes).
 */
export function renderRequests(storage: StorageAdapter, beforeRender: () => Promise<void>): () => void {
  let running = false;
  let again = false;

  const answer = async (request: RenderRequest): Promise<RenderResult> => {
    try {
      await beforeRender();
      // The page before its queue: an apply landing in between leaves the queue empty, not applied twice.
      const page = await storage.getPage(request.pageId);
      if (!page) return { error: "The page no longer exists." };
      const queued = await storage.getQueuedEdits(request.pageId);
      const blob = await renderPage(
        page,
        queued.map((q) => q.edit),
        request.ids,
      );
      return { png: await toBase64(blob) };
    } catch (err) {
      console.error(`Couldn't draw page ${request.pageId} for Claude`, err);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const run = async () => {
    running = true;
    try {
      do {
        again = false;
        for (let request = await storage.claimRender(); request; request = await storage.claimRender()) {
          await storage.finishRender(request.id, await answer(request));
        }
      } while (again);
    } catch (err) {
      console.error("Couldn't answer Claude's render requests", err);
    } finally {
      running = false;
    }
  };

  return () => {
    if (running) again = true;
    else void run();
  };
}

/**
 * Draws a page in the light theme with Claude's waiting edits applied (in
 * memory only: they're still waiting afterwards), optionally cropped to a few
 * shapes plus a margin.
 */
export async function renderPage(page: Page, edits: readonly PageEdit[], ids: string[] | null): Promise<Blob> {
  const elements = (edits.length ? await applyEdits(page.elements, edits) : page.elements).filter(
    (el) => !el.isDeleted,
  ) as NonDeleted<ExcalidrawElement>[];
  if (elements.length === 0) throw new Error("The page is empty.");
  const crop = ids?.length ? cropFrame(elements, ids) : null;
  return exportToBlob({
    // Exporting a frame only draws elements outside every other frame, so
    // inside a crop, shapes leave their frames (and frames aren't outlined).
    elements: crop ? elements.map((el) => (el.frameId ? { ...el, frameId: null } : el)) : elements,
    files: page.files,
    exportingFrame: crop,
    exportPadding: PADDING,
    appState: {
      exportBackground: true,
      viewBackgroundColor: page.appState.viewBackgroundColor ?? "#ffffff",
      exportWithDarkMode: false,
    },
    getDimensions: (width: number, height: number) => {
      const scale = Math.min(MAX_SCALE, MAX_SIDE / Math.max(width, height));
      return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
    },
  });
}

/** An unsaved frame around the given shapes, for exporting just that part of the page. */
function cropFrame(elements: readonly NonDeleted<ExcalidrawElement>[], ids: string[]): ExcalidrawFrameLikeElement {
  const wanted = new Set(ids);
  const picked = elements.filter((el) => wanted.has(el.id));
  if (picked.length === 0) throw new Error("None of those shapes are on the page.");
  const [minX, minY, maxX, maxY] = getCommonBounds(picked);
  const [frame] = convertToExcalidrawElements([
    {
      type: "frame",
      x: minX - CROP_MARGIN,
      y: minY - CROP_MARGIN,
      width: maxX - minX + 2 * CROP_MARGIN,
      height: maxY - minY + 2 * CROP_MARGIN,
      children: [],
    } as ExcalidrawElementSkeleton,
  ]);
  return frame as ExcalidrawFrameLikeElement;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).slice((reader.result as string).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the picture."));
    reader.readAsDataURL(blob);
  });
}
