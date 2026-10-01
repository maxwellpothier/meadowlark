import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

// The simplified view of a page that Claude reads and edits through MCP.
// Claude never sees or writes raw Excalidraw JSON: it gets one flat shape per
// element (bound labels folded into their container, arrow bindings as ids)
// and sends edits in the same vocabulary. The browser turns edits into real
// elements (see apply.ts), because sizing text needs a canvas.
//
// Pure and free of runtime imports so the server can use it too.

export const SHAPE_TYPES = ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "frame"] as const;
export type NewShapeType = (typeof SHAPE_TYPES)[number];

/** Element types an arrow can attach to. */
export const BINDABLE_TYPES: ReadonlySet<string> = new Set(["rectangle", "ellipse", "diamond", "text", "image"]);

export const DEFAULT_SIZE = { width: 160, height: 80 } as const;

/** One element as Claude sees it. Coordinates are rounded scene units; y grows downward. */
export interface Shape {
  id: string;
  /** One of NewShapeType, or what a hand-drawn element is ("image", "freedraw", ...). */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text of a text element, label of a shape or arrow, or name of a frame. */
  label?: string;
  /** Arrows: ids of the elements the ends are attached to. */
  start?: string;
  end?: string;
  strokeColor?: string;
  backgroundColor?: string;
  /** Id of the frame this element sits in. */
  frameId?: string;
}

export interface NewShape {
  /** Optional, so other shapes in the same edit can refer to it. Assigned if missing. */
  id?: string;
  type: NewShapeType;
  /** Required except for arrows that have both start and end. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  start?: string;
  end?: string;
  /** Lines and unattached arrows: points relative to x/y. Defaults to a straight segment of width/height. */
  points?: [number, number][];
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeStyle?: "solid" | "dashed" | "dotted";
  fontSize?: number;
  /** Frames: ids of the elements inside it. */
  children?: string[];
}

export interface ShapeUpdate {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Empty string removes a label. */
  label?: string;
  /** Arrows: re-attach an end. */
  start?: string;
  end?: string;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeStyle?: "solid" | "dashed" | "dotted";
  fontSize?: number;
}

/** One batch of changes from Claude. Applied in order: remove, update, add. */
export interface PageEdit {
  add?: NewShape[];
  update?: ShapeUpdate[];
  remove?: string[];
}

/** An edit as stored: every added shape has an id. */
export interface QueuedEdit {
  id: number;
  createdAt: number;
  edit: PageEdit;
}

const DEFAULT_STROKE = "#1e1e1e";
const DEFAULT_BACKGROUND = "transparent";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type AnyElement = ExcalidrawElement & Record<string, unknown>;

/** Converts stored elements to Claude's view. Bound text is folded into its container's label. */
export function toShapes(elements: readonly ExcalidrawElement[]): Shape[] {
  const live = elements.filter((el) => !el.isDeleted) as AnyElement[];
  const byId = new Map(live.map((el) => [el.id, el]));
  const shapes: Shape[] = [];
  for (const el of live) {
    if (el.type === "text" && el.containerId && byId.has(el.containerId as string)) continue;
    const shape: Shape = {
      id: el.id,
      type: el.type,
      x: Math.round(el.x),
      y: Math.round(el.y),
      width: Math.round(el.width),
      height: Math.round(el.height),
    };
    const label = labelOf(el, byId);
    if (label) shape.label = label;
    const start = (el.startBinding as { elementId?: string } | null | undefined)?.elementId;
    const end = (el.endBinding as { elementId?: string } | null | undefined)?.elementId;
    if (start) shape.start = start;
    if (end) shape.end = end;
    if (el.strokeColor !== DEFAULT_STROKE) shape.strokeColor = el.strokeColor;
    if (el.backgroundColor !== DEFAULT_BACKGROUND) shape.backgroundColor = el.backgroundColor;
    if (el.frameId) shape.frameId = el.frameId as string;
    shapes.push(shape);
  }
  return shapes;
}

function labelOf(el: AnyElement, byId: Map<string, AnyElement>): string | undefined {
  if (el.type === "text") return (el.originalText as string | undefined) ?? (el.text as string);
  if (el.type === "frame" || el.type === "magicframe") return (el.name as string | null) ?? undefined;
  const bound = (el.boundElements as { type: string; id: string }[] | null)?.find((b) => b.type === "text");
  const text = bound ? byId.get(bound.id) : undefined;
  return text ? ((text.originalText as string | undefined) ?? (text.text as string)) : undefined;
}

/**
 * Checks an edit against the page as Claude would see it, and fills in ids
 * for added shapes. Returns the edit to store, or a list of problems.
 */
export function prepareEdit(
  shapes: readonly Shape[],
  edit: PageEdit,
  newId: () => string,
): { edit: PageEdit; errors: [] } | { edit: null; errors: string[] } {
  const errors: string[] = [];
  const existing = new Map(shapes.map((s) => [s.id, s]));
  const remove = [...new Set(edit.remove ?? [])];
  const update = edit.update ?? [];
  const add = (edit.add ?? []).map((s) => ({ ...s, id: s.id ?? newId() }));

  for (const id of remove) if (!existing.has(id)) errors.push(`remove: no element "${id}" on this page.`);
  const removed = new Set(remove);

  const afterRemoval = new Map([...existing].filter(([id]) => !removed.has(id)));
  const types = new Map([...afterRemoval].map(([id, s]) => [id, s.type]));
  const addIds = new Set<string>();
  for (const s of add) {
    if (!ID_PATTERN.test(s.id)) errors.push(`add: id "${s.id}" must be 1-64 letters, digits, "-" or "_".`);
    else if (existing.has(s.id) || addIds.has(s.id)) errors.push(`add: id "${s.id}" is already in use.`);
    addIds.add(s.id);
    types.set(s.id, s.type);
  }

  for (const u of update) {
    const target = afterRemoval.get(u.id);
    if (!target) {
      errors.push(`update: no element "${u.id}" on this page${removed.has(u.id) ? " (it is also being removed)" : ""}.`);
      continue;
    }
    if ((u.start !== undefined || u.end !== undefined) && target.type !== "arrow") {
      errors.push(`update: "${u.id}" is a ${target.type}; only arrows have start/end.`);
    }
    for (const ref of [u.start, u.end]) if (ref) checkBindable(ref, types, `update "${u.id}"`, errors);
  }

  for (const s of add) {
    const where = `add "${s.id}"`;
    if (!(SHAPE_TYPES as readonly string[]).includes(s.type)) {
      errors.push(`${where}: type must be one of ${SHAPE_TYPES.join(", ")}.`);
      continue;
    }
    const attached = s.type === "arrow" && s.start && s.end;
    if (!attached && (typeof s.x !== "number" || typeof s.y !== "number")) {
      errors.push(`${where}: x and y are required${s.type === "arrow" ? " unless the arrow has both start and end" : ""}.`);
    }
    if (s.type === "text" && !s.label) errors.push(`${where}: text elements need a label (the text).`);
    if ((s.start || s.end) && s.type !== "arrow") errors.push(`${where}: only arrows have start/end.`);
    for (const ref of [s.start, s.end]) if (ref) checkBindable(ref, types, where, errors);
    for (const child of s.children ?? []) {
      if (!types.has(child)) errors.push(`${where}: child "${child}" doesn't exist.`);
    }
    if (s.children && s.type !== "frame") errors.push(`${where}: only frames have children.`);
  }

  // A rewrite belongs on a new page, so hand-drawn work can't vanish in one edit.
  if (remove.length > 0 && remove.length * 2 > shapes.length) {
    errors.push(
      `This removes ${remove.length} of ${shapes.length} elements. Edits may remove at most half of a page; ` +
        "use add_page for a redo so the original page stays as it is.",
    );
  }

  if (errors.length) return { edit: null, errors };
  const out: PageEdit = {};
  if (remove.length) out.remove = remove;
  if (update.length) out.update = update;
  if (add.length) out.add = add;
  return { edit: out, errors: [] };
}

function checkBindable(ref: string, types: Map<string, string>, where: string, errors: string[]): void {
  const type = types.get(ref);
  if (!type) errors.push(`${where}: no element "${ref}" to attach to.`);
  else if (!BINDABLE_TYPES.has(type)) errors.push(`${where}: arrows can't attach to a ${type} ("${ref}").`);
}

/**
 * Applies edits to Claude's view without Excalidraw, so Claude can read a page
 * whose queued edits the app hasn't applied yet. Sizes of new shapes are
 * estimates until then.
 */
export function projectEdits(shapes: readonly Shape[], edits: readonly PageEdit[]): Shape[] {
  let out = shapes.map((s) => ({ ...s }));
  for (const edit of edits) {
    const removed = new Set(edit.remove ?? []);
    out = out.filter((s) => !removed.has(s.id));
    for (const s of out) {
      if (s.start && removed.has(s.start)) delete s.start;
      if (s.end && removed.has(s.end)) delete s.end;
      if (s.frameId && removed.has(s.frameId)) delete s.frameId;
    }
    const byId = new Map(out.map((s) => [s.id, s]));
    for (const u of edit.update ?? []) {
      const s = byId.get(u.id);
      if (!s) continue;
      for (const key of ["x", "y", "width", "height", "strokeColor", "backgroundColor", "start", "end"] as const) {
        if (u[key] !== undefined) (s as unknown as Record<string, unknown>)[key] = u[key];
      }
      if (u.label !== undefined) {
        if (u.label) s.label = u.label;
        else delete s.label;
      }
    }
    for (const n of edit.add ?? []) {
      const s: Shape = {
        id: n.id!,
        type: n.type,
        x: Math.round(n.x ?? 0),
        y: Math.round(n.y ?? 0),
        width: Math.round(n.width ?? (n.type === "text" || n.type === "arrow" || n.type === "line" ? 0 : DEFAULT_SIZE.width)),
        height: Math.round(n.height ?? (n.type === "text" || n.type === "arrow" || n.type === "line" ? 0 : DEFAULT_SIZE.height)),
      };
      if (n.label) s.label = n.label;
      if (n.start) s.start = n.start;
      if (n.end) s.end = n.end;
      if (n.strokeColor) s.strokeColor = n.strokeColor;
      if (n.backgroundColor) s.backgroundColor = n.backgroundColor;
      out.push(s);
      byId.set(s.id, s);
      for (const child of n.children ?? []) {
        const c = byId.get(child);
        if (c) c.frameId = s.id;
      }
    }
    // Attached arrows follow their ends.
    for (const s of out) {
      if (s.type !== "arrow") continue;
      const a = s.start ? byId.get(s.start) : undefined;
      const b = s.end ? byId.get(s.end) : undefined;
      if (!a || !b) continue;
      const [p, q] = arrowEndpoints(a, b);
      Object.assign(s, {
        x: Math.round(p[0]),
        y: Math.round(p[1]),
        width: Math.round(Math.abs(q[0] - p[0])),
        height: Math.round(Math.abs(q[1] - p[1])),
      });
    }
  }
  return out;
}

export interface Box {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ARROW_GAP = 8;

/**
 * Where a straight arrow from box a to box b should start and end: on each
 * box's outline, along the line between their centres, with a small gap.
 */
export function arrowEndpoints(a: Box, b: Box): [[number, number], [number, number]] {
  return [outlinePoint(a, centre(b)), outlinePoint(b, centre(a))];
}

export function centre(box: Box): [number, number] {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/** The point just outside the box's outline on the way from its centre to `toward`. */
export function outlinePoint(box: Box, toward: [number, number]): [number, number] {
  const from = centre(box);
  const dx = toward[0] - from[0];
  const dy = toward[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return from;
  const ux = dx / len;
  const uy = dy / len;
  const hw = box.width / 2;
  const hh = box.height / 2;
  let t: number;
  if (box.type === "ellipse") {
    t = hw && hh ? 1 / Math.sqrt((ux / hw) ** 2 + (uy / hh) ** 2) : 0;
  } else if (box.type === "diamond") {
    t = hw && hh ? 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh) : 0;
  } else {
    const tx = ux === 0 ? Infinity : hw / Math.abs(ux);
    const ty = uy === 0 ? Infinity : hh / Math.abs(uy);
    t = Math.min(tx, ty);
  }
  // Never run past the midpoint, even when the boxes overlap.
  t = Math.min(t + ARROW_GAP, len / 2);
  return [from[0] + ux * t, from[1] + uy * t];
}
