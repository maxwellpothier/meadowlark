import { convertToExcalidrawElements, exportToCanvas, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import {
  ARROW_GAP,
  BINDABLE_TYPES,
  DEFAULT_SIZE,
  arrowEndpoints,
  outlinePoint,
  type Box,
  type NewShape,
  type PageEdit,
  type ShapeUpdate,
} from "./model";

// Turns Claude's edits into real Excalidraw elements. Runs in the browser
// because sizing text (labels grow their boxes) needs a canvas. Everything
// that isn't text layout is plain geometry from model.ts.

// Working copies are plain mutable objects; Excalidraw's element types are
// readonly unions that don't help when patching fields by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = Record<string, any> & { id: string; type: string };
type Binding = { type: string; id: string };

const LABELLED = new Set(["rectangle", "ellipse", "diamond", "arrow"]);
const FRAME_PADDING = 40;
const FONT_TIMEOUT_MS = 3000;

/** Applies Claude's edits, in order, to a page's elements. Edits that refer to things since removed are skipped. */
export async function applyEdits(elements: readonly ExcalidrawElement[], edits: readonly PageEdit[]): Promise<ExcalidrawElement[]> {
  await loadFonts(elements, edits);
  const work = new Work(elements);
  for (const edit of edits) {
    for (const id of edit.remove ?? []) work.remove(id);
    for (const update of edit.update ?? []) work.update(update);
    work.add(edit.add ?? []);
  }
  return work.result();
}

/**
 * Re-sizes text that was measured before its font had loaded (see loadFonts),
 * which shows up as words cut off at the edges. This is what double-clicking
 * the text does by hand. Returns `elements` itself when nothing needed it.
 */
export async function fitText(elements: readonly ExcalidrawElement[]): Promise<readonly ExcalidrawElement[]> {
  const texts = elements.filter((el) => el.type === "text" && !el.isDeleted) as unknown as El[];
  if (texts.length === 0) return elements;
  await loadFonts(elements, []);
  const measured = convert(
    texts.map((el) => ({ type: "text", x: 0, y: 0, text: el.text, fontSize: el.fontSize, fontFamily: el.fontFamily }) as ExcalidrawElementSkeleton),
  );
  // Fixed-width text wraps to its box, so re-measuring it as one line would be wrong.
  const clipped = texts.filter((el, i) => measured[i].width > el.width + 1 && (el.containerId || el.autoResize !== false));
  if (clipped.length === 0) return elements;
  const work = new Work(elements);
  for (const el of clipped) work.update({ id: el.containerId ?? el.id, label: el.originalText || el.text });
  return work.result();
}

/**
 * Excalidraw sizes text with whichever font the browser has at that moment,
 * and until Excalifont has loaded that's a narrower fallback, so the text is
 * clipped once the real font draws it. Nothing loads a font until something
 * on screen uses it (a new, empty page uses none), so load the fonts the page
 * and Claude's text need first. Exporting to a tiny canvas is the public API
 * that does this.
 */
async function loadFonts(elements: readonly ExcalidrawElement[], edits: readonly PageEdit[]): Promise<void> {
  const labels = edits.flatMap((e) => [...(e.add ?? []), ...(e.update ?? [])].map((s) => s.label).filter((l): l is string => !!l));
  const samples = convert(labels.map((text) => ({ type: "text", x: 0, y: 0, text }) as ExcalidrawElementSkeleton));
  const texts = [...elements.filter((el) => el.type === "text" && !el.isDeleted), ...(samples as unknown as ExcalidrawElement[])];
  if (texts.length === 0) return;
  const loaded = exportToCanvas({ elements: texts, files: null, maxWidthOrHeight: 1 }).catch((err: unknown) => {
    console.warn("Couldn't load fonts; text may be sized with a fallback font", err);
  });
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS))]);
}

class Work {
  private order: string[];
  private map: Map<string, El>;
  private touched = new Set<string>();

  constructor(elements: readonly ExcalidrawElement[]) {
    const live = elements.filter((el) => !el.isDeleted).map((el) => structuredClone(el) as unknown as El);
    this.order = live.map((el) => el.id);
    this.map = new Map(live.map((el) => [el.id, el]));
  }

  remove(id: string): void {
    const el = this.map.get(id);
    if (!el) return;
    for (const b of (el.boundElements ?? []) as Binding[]) if (b.type === "text") this.drop(b.id);
    this.drop(id);
    for (const other of this.map.values()) {
      if (other.startBinding?.elementId === id) this.patch(other, { startBinding: null });
      if (other.endBinding?.elementId === id) this.patch(other, { endBinding: null });
      if (other.frameId === id) this.patch(other, { frameId: null });
      const bound = other.boundElements as Binding[] | null;
      if (bound?.some((b) => b.id === id)) this.patch(other, { boundElements: bound.filter((b) => b.id !== id) });
    }
  }

  update(u: ShapeUpdate): void {
    const el = this.map.get(u.id);
    if (!el) return; // removed by hand since Claude read the page
    const linear = el.type === "arrow" || el.type === "line";
    const moved = u.x !== undefined || u.y !== undefined || (!linear && (u.width !== undefined || u.height !== undefined));
    const patch: Partial<El> = {};
    for (const key of ["x", "y", ...(linear ? [] : ["width", "height"])] as const) {
      if (u[key as keyof ShapeUpdate] !== undefined) patch[key] = u[key as keyof ShapeUpdate];
    }
    for (const key of ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle"] as const) {
      if (u[key] !== undefined) patch[key] = u[key];
    }
    this.patch(el, patch);
    const before = box(el);

    if (el.type === "arrow" && (u.start !== undefined || u.end !== undefined)) {
      if (u.start !== undefined) this.bind(el, "start", u.start);
      if (u.end !== undefined) this.bind(el, "end", u.end);
      this.reroute(el);
    }

    if (el.type === "text" && !el.containerId) {
      if (u.label || u.fontSize !== undefined) this.setFreeText(el, u.label || el.originalText || el.text, u.fontSize);
    } else if (el.type === "frame") {
      if (u.label !== undefined) this.patch(el, { name: u.label || null });
    } else if (LABELLED.has(el.type)) {
      const current = this.labelOf(el);
      if (u.label !== undefined || u.fontSize !== undefined || (moved && current)) {
        this.setLabel(el, u.label !== undefined ? u.label : (current?.originalText ?? ""), u.fontSize);
      }
    }

    // A new label can grow the box, which moves where arrows meet it.
    const after = box(el);
    const resized = after.y !== before.y || after.width !== before.width || after.height !== before.height;
    if ((moved || resized) && BINDABLE_TYPES.has(el.type)) {
      for (const other of [...this.map.values()]) {
        if (other.type === "arrow" && (other.startBinding?.elementId === el.id || other.endBinding?.elementId === el.id)) {
          this.reroute(other);
        }
      }
    }
  }

  add(shapes: readonly NewShape[]): void {
    // Boxes and text first, so arrows can be routed to them.
    const boxes = shapes.filter((s) => s.type !== "arrow" && s.type !== "line" && s.type !== "frame");
    for (const el of convert(boxes.map((s) => fitWords(boxSkeleton(s))))) this.put(el);

    for (const s of shapes.filter((s) => s.type === "frame")) {
      const children = (s.children ?? []).map((id) => this.map.get(id)).filter((c): c is El => !!c);
      const bounds = s.width === undefined || s.height === undefined ? boundsOf(children, FRAME_PADDING) : null;
      const [frame] = convert([
        {
          type: "frame",
          id: s.id,
          x: bounds?.x ?? s.x ?? 0,
          y: bounds?.y ?? s.y ?? 0,
          width: bounds?.width ?? s.width ?? 400,
          height: bounds?.height ?? s.height ?? 300,
          name: s.label ?? null,
          children: [],
        } as ExcalidrawElementSkeleton,
      ]);
      // Frames sit below their children.
      this.put(frame, null, true);
      for (const child of children) this.patch(child, { frameId: frame.id });
    }

    for (const s of shapes.filter((s) => s.type === "arrow" || s.type === "line")) {
      const geometry = this.linearGeometry(s);
      const converted = convert([
        {
          type: s.type,
          id: s.id,
          ...geometry,
          ...style(s),
          ...(s.label ? { label: { text: s.label, fontSize: s.fontSize } } : {}),
        } as ExcalidrawElementSkeleton,
      ]);
      for (const el of converted) this.put(el);
      const el = this.map.get(s.id!)!;
      if (s.type === "arrow") {
        if (s.start) this.bind(el, "start", s.start);
        if (s.end) this.bind(el, "end", s.end);
      }
    }
  }

  result(): ExcalidrawElement[] {
    const now = Date.now();
    const out = this.order.map((id) => this.map.get(id)!).filter(Boolean);
    for (const el of out) {
      if (!this.touched.has(el.id)) continue;
      el.version = (el.version ?? 0) + 1;
      el.versionNonce = Math.floor(Math.random() * 2 ** 31);
      el.updated = now;
      el.index = null; // let restoreElements assign fractional indices from the final order
    }
    return restoreElements(out as unknown as ExcalidrawElement[], null, { repairBindings: true });
  }

  // ---- helpers --------------------------------------------------------------

  private linearGeometry(s: NewShape): { x: number; y: number; width: number; height: number; points: [number, number][] } {
    const a = s.start ? this.map.get(s.start) : undefined;
    const b = s.end ? this.map.get(s.end) : undefined;
    if (s.type === "arrow" && a && b) {
      const [p, q] = arrowEndpoints(box(a), box(b));
      return straight(p, q);
    }
    const points = s.points ?? [
      [0, 0],
      [s.width ?? 100, s.height ?? 0],
    ];
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      x: s.x ?? 0,
      y: s.y ?? 0,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points,
    };
  }

  /** Attaches one end of an arrow to an element, or detaches it with "". */
  private bind(arrow: El, end: "start" | "end", targetId: string): void {
    const key = end === "start" ? "startBinding" : "endBinding";
    const previous = arrow[key]?.elementId as string | undefined;
    if (previous) {
      const prevTarget = this.map.get(previous);
      const stillBound = (end === "start" ? arrow.endBinding : arrow.startBinding)?.elementId === previous;
      if (prevTarget && !stillBound) {
        const bound = (prevTarget.boundElements ?? []) as Binding[];
        this.patch(prevTarget, { boundElements: bound.filter((b) => b.id !== arrow.id) });
      }
    }
    const target = targetId ? this.map.get(targetId) : undefined;
    this.patch(arrow, { [key]: target ? { elementId: target.id, focus: 0, gap: ARROW_GAP } : null });
    if (target) {
      const bound = (target.boundElements ?? []) as Binding[];
      if (!bound.some((b) => b.id === arrow.id)) {
        this.patch(target, { boundElements: [...bound, { type: "arrow", id: arrow.id }] });
      }
    }
  }

  /** Re-draws an attached arrow as a straight line between what it's attached to. */
  private reroute(arrow: El): void {
    const a = arrow.startBinding ? this.map.get(arrow.startBinding.elementId) : undefined;
    const b = arrow.endBinding ? this.map.get(arrow.endBinding.elementId) : undefined;
    if (!a && !b) return;
    const pts = arrow.points as [number, number][];
    let p: [number, number] = [arrow.x + pts[0][0], arrow.y + pts[0][1]];
    let q: [number, number] = [arrow.x + pts[pts.length - 1][0], arrow.y + pts[pts.length - 1][1]];
    if (a && b) [p, q] = arrowEndpoints(box(a), box(b));
    else if (a) p = outlinePoint(box(a), q);
    else if (b) q = outlinePoint(box(b), p);
    this.patch(arrow, straight(p, q));
    const label = this.labelOf(arrow);
    if (label) this.setLabel(arrow, label.originalText ?? label.text);
  }

  private labelOf(container: El): El | undefined {
    const ref = ((container.boundElements ?? []) as Binding[]).find((b) => b.type === "text");
    return ref ? this.map.get(ref.id) : undefined;
  }

  /** Replaces a container's label, letting Excalidraw size the text and grow the box to fit. */
  private setLabel(container: El, text: string, fontSize?: number): void {
    const old = this.labelOf(container);
    const bound = ((container.boundElements ?? []) as Binding[]).filter((b) => b.type !== "text");
    if (old) this.drop(old.id);
    this.patch(container, { boundElements: bound });
    if (!text) return;

    const converted = convert([
      fitWords({
        type: container.type,
        id: container.id,
        x: container.x,
        y: container.y,
        width: container.width,
        height: container.height,
        ...(container.type === "arrow" ? { points: container.points } : {}),
        label: { text, fontSize: fontSize ?? old?.fontSize, fontFamily: old?.fontFamily },
      } as ExcalidrawElementSkeleton),
    ]);
    const label = converted.find((el) => el.type === "text");
    const sized = converted.find((el) => el.id === container.id);
    if (!label) return;
    if (sized && container.type !== "arrow") this.patch(container, { x: sized.x, y: sized.y, width: sized.width, height: sized.height });
    this.patch(container, { boundElements: [...bound, { type: "text", id: label.id }] });
    if (old?.strokeColor) label.strokeColor = old.strokeColor;
    this.put(label, container.id);
  }

  private setFreeText(el: El, text: string, fontSize?: number): void {
    const [measured] = convert([
      {
        type: "text",
        x: el.x,
        y: el.y,
        text,
        fontSize: fontSize ?? el.fontSize,
        fontFamily: el.fontFamily,
        textAlign: el.textAlign,
      } as ExcalidrawElementSkeleton,
    ]);
    const { text: t, originalText, width, height, lineHeight } = measured;
    this.patch(el, { text: t, originalText, width, height, lineHeight, fontSize: measured.fontSize });
  }

  private patch(el: El, fields: Partial<El>): void {
    Object.assign(el, fields);
    this.touched.add(el.id);
  }

  /** Adds or replaces an element; new ones go after `afterId`, at the bottom, or on top. */
  private put(el: El, afterId: string | null = null, bottom = false): void {
    if (!this.map.has(el.id)) {
      const at = afterId ? this.order.indexOf(afterId) : -1;
      if (at >= 0) this.order.splice(at + 1, 0, el.id);
      else if (bottom) this.order.unshift(el.id);
      else this.order.push(el.id);
    }
    this.map.set(el.id, el);
    this.touched.add(el.id);
  }

  private drop(id: string): void {
    if (!this.map.delete(id)) return;
    this.order = this.order.filter((x) => x !== id);
  }
}

function convert(skeletons: ExcalidrawElementSkeleton[]): El[] {
  if (skeletons.length === 0) return [];
  return convertToExcalidrawElements(skeletons, { regenerateIds: false }) as unknown as El[];
}

// How much of a box's width Excalidraw lets its label use (getBoundTextMaxWidth), less padding.
const LABEL_SHARE: Record<string, number> = { rectangle: 1, ellipse: Math.SQRT1_2, diamond: 0.5 };
const LABEL_PADDING = 5;

/**
 * Widens a box, keeping its centre, so the longest word of its label fits.
 * Excalidraw wraps a label to its box and breaks words that don't fit, which
 * turns identifiers like handleIncomingWebhookEvent into "handleIncomingWebhook / Event".
 */
function fitWords(skeleton: ExcalidrawElementSkeleton): ExcalidrawElementSkeleton {
  const s = skeleton as El;
  const share = LABEL_SHARE[s.type];
  const words = (s.label?.text as string | undefined)?.split(/\s+/).filter(Boolean);
  if (!share || !words?.length) return skeleton;
  const [measured] = convert([
    { type: "text", x: 0, y: 0, text: words.join("\n"), fontSize: s.label.fontSize, fontFamily: s.label.fontFamily } as ExcalidrawElementSkeleton,
  ]);
  const needed = Math.ceil((measured.width + 2 * LABEL_PADDING + 2) / share);
  const width = s.width ?? DEFAULT_SIZE.width;
  if (needed <= width) return skeleton;
  return { ...s, x: (s.x ?? 0) - (needed - width) / 2, width: needed } as ExcalidrawElementSkeleton;
}

function boxSkeleton(s: NewShape): ExcalidrawElementSkeleton {
  if (s.type === "text") {
    return { type: "text", id: s.id, x: s.x ?? 0, y: s.y ?? 0, text: s.label ?? "", fontSize: s.fontSize, ...style(s) } as ExcalidrawElementSkeleton;
  }
  return {
    type: s.type,
    id: s.id,
    x: s.x ?? 0,
    y: s.y ?? 0,
    width: s.width ?? DEFAULT_SIZE.width,
    height: s.height ?? DEFAULT_SIZE.height,
    ...style(s),
    ...(s.label ? { label: { text: s.label, fontSize: s.fontSize } } : {}),
  } as ExcalidrawElementSkeleton;
}

function style(s: NewShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle"] as const) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  return out;
}

function box(el: El): Box {
  return { type: el.type, x: el.x, y: el.y, width: el.width, height: el.height };
}

function straight(p: [number, number], q: [number, number]) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  return {
    x: p[0],
    y: p[1],
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ] as [number, number][],
  };
}

function boundsOf(elements: El[], padding: number): Box | null {
  if (elements.length === 0) return null;
  const x = Math.min(...elements.map((e) => e.x)) - padding;
  const y = Math.min(...elements.map((e) => e.y)) - padding;
  const right = Math.max(...elements.map((e) => e.x + e.width)) + padding;
  const bottom = Math.max(...elements.map((e) => e.y + e.height)) + padding;
  return { type: "frame", x, y, width: right - x, height: bottom - y };
}

