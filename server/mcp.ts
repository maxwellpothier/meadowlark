// Meadowlark's MCP server. Claude Code starts one per session (over stdio),
// and it reads and writes the same SQLite file as the app, so it works
// whether or not the app is running.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SHAPE_TYPES, type Shape } from "../src/claude/model.ts";
import type { RenderResult, SceneRect } from "../src/storage/types.ts";
import { openDb } from "./db.ts";
import { detectRepo } from "./repo.ts";
import { Store } from "./store.ts";

const INSTRUCTIONS = `Meadowlark is the user's local Excalidraw whiteboard, organised as pages.
Use it to sketch or explain things visually: architecture, flows, sequences, scoping.

How pages look to you: a flat list of shapes { id, type, x, y, width, height, label?, start?, end?, ... }.
Coordinates are scene units, y grows downward. A box's label is its text; an arrow's start/end are the ids
of the shapes it connects. Arrows with start and end are routed for you, so give them no coordinates.

Layout guidance: boxes around 160x80 (wider for long labels), 80-100 apart, or about 180 apart when the
arrow between them has a label, flowing left-to-right or top-to-bottom. Text defaults to fontSize 20. Colours are hex: strokes #1e1e1e (default), #1971c2 blue,
#2f9e44 green, #e03131 red, #f08c00 orange; light fills #a5d8ff, #b2f2bb, #ffc9c9, #ffec99 with fillStyle "solid".
Use frames (type "frame" with children) to group a region.

Written notes ("write this up") are text elements. Text doesn't wrap by itself, so break lines yourself at about
70 characters. Use fontSize 28 for a title and 24 for headings, one text element per section stacked top to bottom,
and boxes for callouts or anything worth drawing next to the prose.

Seeing what you drew: after add_page or edit_page has returned (not in the same batch of calls), call render_page
and look at the picture before you tell the user you're done. Fix overlapping shapes, cut-off labels and arrows
crossing boxes with another edit. On a big page, pass ids to look closer at one part. Rendering needs Meadowlark
open in a browser. If it isn't, make no more edits you can't see: ask the user in one line to open it, and render
again once they have.

What the user is looking at: when they point at something without naming it ("this", "here", "the selected boxes",
"what I'm looking at"), call get_context first. It gives the open page, the selected shapes and what's on screen.

Rules:
- Edits to an existing page change only what was asked. Read the page first; the user may have moved
  or added things by hand since you last saw it, and those changes must survive.
- For a redo ("redraw this as a sequence diagram", "start over"), use add_page, never a big edit. An edit
  that removes more than half of a page's elements is refused.
- You cannot delete pages.
- Edits don't appear instantly: the app applies them, asking the user first if it's their own page and open. read_page
  already includes edits that are still waiting. revert_page undoes your most recent change.
- Pages you create land in the user's Inbox at the bottom of the sidebar until they keep them.
- The user opens the app themselves. Tell them the page name you created or changed.`;

/** How long render_page waits for an open tab to take its request before deciding the app isn't open. */
const CLAIM_TIMEOUT_MS = 3_000;
/** How long a tab gets to draw the page once it has taken the request. */
const RENDER_TIMEOUT_MS = 20_000;
const POLL_MS = 150;
/** The app re-sends the context every 30 s while it's in front, so older than this means it's closed. */
const CONTEXT_STALE_MS = 90_000;

const fill = z.enum(["solid", "hachure", "cross-hatch"]);
const stroke = z.enum(["solid", "dashed", "dotted"]);

const newShape = z.object({
  id: z.string().optional().describe("Your id for this shape, so other shapes in the same call can refer to it."),
  type: z.enum(SHAPE_TYPES),
  x: z.number().optional().describe("Left edge (or start point for lines). Required except for arrows with start and end."),
  y: z.number().optional().describe("Top edge. Required except for arrows with start and end."),
  width: z.number().optional().describe("Defaults to 160 for boxes; text sizes itself."),
  height: z.number().optional().describe("Defaults to 80 for boxes; grows to fit the label."),
  label: z.string().optional().describe("Text for text elements, label for boxes and arrows, name for frames."),
  start: z.string().optional().describe("Arrows: id of the shape the arrow leaves from."),
  end: z.string().optional().describe("Arrows: id of the shape the arrow points to."),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe("Lines and unattached arrows: points relative to x/y."),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: fill.optional(),
  strokeStyle: stroke.optional(),
  fontSize: z.number().optional(),
  children: z.array(z.string()).optional().describe("Frames: ids of the shapes inside it."),
});

const shapeUpdate = z.object({
  id: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  label: z.string().optional().describe('New label. "" removes it.'),
  start: z.string().optional().describe("Arrows: re-attach the start."),
  end: z.string().optional().describe("Arrows: re-attach the end."),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: fill.optional(),
  strokeStyle: stroke.optional(),
  fontSize: z.number().optional(),
});

const store = new Store(openDb());
const repo = detectRepo();
const server = new McpServer({ name: "meadowlark", version: "1.0.0" }, { instructions: INSTRUCTIONS });

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] });
const fail = (...errors: string[]) => ({ content: [{ type: "text" as const, text: errors.join("\n") }], isError: true });

server.registerTool(
  "list_pages",
  {
    description: "List Meadowlark pages, most recently changed first. Filter by part of the name.",
    inputSchema: { query: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  ({ query }) =>
    ok(
      store.findPages(query).map((p) => ({
        id: p.id,
        name: p.name,
        updatedAt: new Date(p.updatedAt).toISOString(),
        repo: p.repo ?? undefined,
        pinned: p.pinnedAt != null || undefined,
        inbox: p.inbox || undefined,
        savedForLater: p.savedAt != null || undefined,
        elements: p.elementCount,
        pendingEdits: p.claude?.queued || undefined,
      })),
    ),
);

server.registerTool(
  "read_page",
  {
    description: "Read a page's shapes, including your edits the app hasn't applied yet.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ id }) => {
    const page = store.readForClaude(id);
    if (!page) return fail(`No page with id "${id}". Use list_pages to find it.`);
    return ok({
      id: page.meta.id,
      name: page.meta.name,
      repo: page.meta.repo ?? undefined,
      pendingEdits: page.meta.claude?.queued || undefined,
      shapes: page.shapes,
    });
  },
);

server.registerTool(
  "add_page",
  {
    description: "Create a new page with the given shapes. Also use this for a redo of an existing page.",
    inputSchema: { name: z.string().min(1), shapes: z.array(newShape).min(1) },
  },
  ({ name, shapes }) => {
    const result = store.addClaudePage(name, shapes, repo);
    if (!result.ok) return fail(...result.errors);
    return ok({ id: result.pageId, name, addedIds: result.addedIds, note: "The app draws it the next time it's open." });
  },
);

server.registerTool(
  "edit_page",
  {
    description:
      "Change an existing page: remove shapes, update them, then add new ones (in that order). " +
      "Read the page first. Removing more than half of the page's shapes is refused; use add_page instead.",
    inputSchema: {
      id: z.string(),
      remove: z.array(z.string()).optional().describe("Ids of shapes to remove."),
      update: z.array(shapeUpdate).optional(),
      add: z.array(newShape).optional(),
    },
  },
  ({ id, remove, update, add }) => {
    if (!remove?.length && !update?.length && !add?.length) return fail("Nothing to change.");
    const result = store.queueEdit(id, { remove, update, add });
    if (!result.ok) return fail(...result.errors);
    return ok({
      id,
      addedIds: result.addedIds.length ? result.addedIds : undefined,
      note: "Queued. The app applies it, asking the user first only if it's their own page and it's open.",
    });
  },
);

server.registerTool(
  "revert_page",
  {
    description: "Undo your most recent change to a page: a waiting edit, or else the last one the app applied.",
    inputSchema: { id: z.string() },
  },
  ({ id }) => {
    const outcome = store.revertLatestClaudeChange(id);
    if (outcome === null) return fail(`No page with id "${id}".`);
    if (outcome === "nothing") return fail("There's no change of yours to revert on this page.");
    return ok({
      id,
      reverted: outcome === "dropped-queued" ? "Dropped your newest waiting edit." : "Restored the page from before your last change.",
    });
  },
);

server.registerTool(
  "render_page",
  {
    description:
      "See a page as a picture, including your edits the app hasn't applied yet. Use it after drawing to check the " +
      "layout. Pass ids to crop to those shapes (frames aren't outlined in a crop). Needs Meadowlark open in a browser.",
    inputSchema: {
      id: z.string(),
      ids: z.array(z.string()).optional().describe("Crop to these shapes, plus a margin."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, ids }) => {
    const page = store.readForClaude(id);
    if (!page) return fail(`No page with id "${id}". Use list_pages to find it.`);
    if (page.shapes.length === 0) return fail("The page is empty.");
    const known = new Set(page.shapes.map((s) => s.id));
    const unknown = (ids ?? []).filter((s) => !known.has(s));
    if (unknown.length) return fail(`No shapes with these ids on the page: ${unknown.join(", ")}.`);

    const requestId = store.requestRender(id, ids?.length ? ids : null);
    if (requestId === null) return fail(`No page with id "${id}". Use list_pages to find it.`);
    const outcome = await waitForRender(requestId);
    if (outcome === "not-open") {
      return fail("Meadowlark isn't open in a browser, so the page can't be drawn. Make no more edits you can't see: ask the user to open it, then render again.");
    }
    if (outcome === "timeout") return fail("The app took too long to draw the page.");
    if ("error" in outcome) return fail(`The app couldn't draw the page: ${outcome.error}`);
    return {
      content: [
        { type: "image" as const, data: outcome.png, mimeType: "image/png" },
        {
          type: "text" as const,
          text: JSON.stringify({ id, name: page.meta.name, pendingEdits: page.meta.claude?.queued || undefined }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_context",
  {
    description:
      "What the user is looking at in Meadowlark: the open page, the shapes they've selected, and which shapes are on " +
      "screen. Use it when they say \"this\" or \"here\" without naming a page or shape.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => {
    const context = store.getContext();
    if (!context) return fail("Meadowlark hasn't been opened yet, so there's nothing on screen. Ask the user which page they mean.");
    const age = Date.now() - context.updatedAt;
    const app = age > CONTEXT_STALE_MS ? "closed" : context.visible ? "open" : "open in a background tab";
    const page = context.pageId ? store.readForClaude(context.pageId) : null;
    const selected = new Set(context.selectedIds);
    const shapes = page?.shapes ?? [];
    const viewport = context.viewport;
    const unsaved = context.selectedIds.filter((s) => !shapes.some((shape) => shape.id === s)).length;
    return ok({
      app,
      lastSeen: ago(age),
      page: page ? { id: page.meta.id, name: page.meta.name } : null,
      selected: shapes.filter((s) => selected.has(s.id)),
      selectedNotSavedYet: unsaved || undefined,
      onScreen: viewport ? shapes.filter((s) => overlaps(s, viewport)).map((s) => s.id) : undefined,
      viewport: viewport ?? undefined,
      note:
        app === "closed"
          ? "This is what the user last had open. They may be looking at something else now."
          : unsaved
            ? "Some of the selection was just drawn and isn't saved yet. Ask again in a second to see it."
            : undefined,
    });
  },
);

async function waitForRender(requestId: number): Promise<RenderResult | "not-open" | "timeout"> {
  const started = Date.now();
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const status = store.renderStatus(requestId);
      if (!status) return "timeout"; // pruned: only happens after far longer than we wait
      if (status.result) return status.result;
      const waited = Date.now() - started;
      if (!status.claimed && waited > CLAIM_TIMEOUT_MS) return "not-open";
      if (waited > RENDER_TIMEOUT_MS) return "timeout";
    }
  } finally {
    store.dropRender(requestId);
  }
}

function overlaps(shape: Shape, rect: SceneRect): boolean {
  return shape.x < rect.x + rect.width && shape.x + shape.width > rect.x && shape.y < rect.y + rect.height && shape.y + shape.height > rect.y;
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

await server.connect(new StdioServerTransport());
