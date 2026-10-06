import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { file, files, image, rect } from "../src/test/fixtures.ts";
import { openDb } from "./db.ts";
import { Store } from "./store.ts";

let clock = 1000;
let store: Store;

beforeEach(() => {
  clock = 1000;
  store = new Store(openDb(":memory:"), () => clock++);
});

describe("Store pages", () => {
  it("creates, lists and loads pages", () => {
    const a = store.createPage({ name: "A", elements: [rect()], appState: { viewBackgroundColor: "#000" } });
    store.createPage({ name: "B" });
    expect(store.listPages().map((p) => p.name).sort()).toEqual(["A", "B"]);

    const page = store.getPage(a.id);
    expect(page?.elements).toHaveLength(1);
    expect(page?.appState).toEqual({ viewBackgroundColor: "#000" });
    expect(page?.view).toBeNull();
    expect(page?.claude).toEqual({ queued: 0, changedAt: null });
    expect(store.getPage("missing")).toBeNull();
  });

  it("saves scenes, drops deleted elements and bumps updatedAt", () => {
    const meta = store.createPage({ name: "A" });
    const saved = store.savePageScene(meta.id, { elements: [rect(), rect({ isDeleted: true })], appState: {}, files: {} });
    expect(saved!.meta.updatedAt).toBeGreaterThan(meta.updatedAt);
    expect(store.getPage(meta.id)!.elements).toHaveLength(1);
  });

  it("stores new files, prunes unreferenced ones, and reports referenced files it lacks", () => {
    const meta = store.createPage({ name: "A" });
    store.savePageScene(meta.id, { elements: [image("f1"), image("f2")], appState: {}, files: files("f1", "f2", "unused") });
    expect(Object.keys(store.getPage(meta.id)!.files).sort()).toEqual(["f1", "f2"]);

    // f1 isn't resent (the server has it); f2's element is gone.
    const result = store.savePageScene(meta.id, {
      elements: [image("f1"), image("f2", { isDeleted: true }), image("f3")],
      appState: {},
      files: {},
    });
    expect(result!.missingFiles).toEqual(["f3"]);
    const page = store.getPage(meta.id)!;
    expect(Object.keys(page.files)).toEqual(["f1"]);
    expect(page.files.f1).toEqual(file("f1"));
  });

  it("does not resurrect a deleted page on a late save", () => {
    const meta = store.createPage({ name: "A", elements: [image("f1")], files: files("f1") });
    store.deletePage(meta.id);
    expect(store.savePageScene(meta.id, { elements: [image("f1")], appState: {}, files: files("f1") })).toBeNull();
    store.savePageView(meta.id, { scrollX: 1, scrollY: 2, zoom: 1 });
    expect(store.getPage(meta.id)).toBeNull();
    expect(store.listPages()).toEqual([]);
  });

  it("saves the view without bumping updatedAt", () => {
    const meta = store.createPage({ name: "A" });
    store.savePageView(meta.id, { scrollX: 10, scrollY: 20, zoom: 2 });
    store.savePageView(meta.id, { scrollX: 11, scrollY: 20, zoom: 2 });
    const page = store.getPage(meta.id)!;
    expect(page.view).toEqual({ scrollX: 11, scrollY: 20, zoom: 2 });
    expect(page.updatedAt).toBe(meta.updatedAt);
  });

  it("duplicates a page with its files, independently of the original", () => {
    const src = store.createPage({ name: "A", elements: [image("f1")], files: files("f1"), repo: "r" });
    const copy = store.duplicatePage(src.id, "A copy")!;
    expect(copy.id).not.toBe(src.id);
    store.deletePage(src.id);
    const page = store.getPage(copy.id)!;
    expect(page.name).toBe("A copy");
    expect(page.repo).toBe("r");
    expect(Object.keys(page.files)).toEqual(["f1"]);
  });

  it("marks only Claude's pages, and their duplicates, as made by Claude", () => {
    const mine = store.createPage({ name: "Mine" });
    const result = store.addClaudePage("Claude's", [{ type: "text", x: 0, y: 0, label: "hi" }], null);
    if (!result.ok) throw new Error(result.errors.join());
    const copy = store.duplicatePage(result.pageId, "Copy")!;
    expect(mine.byClaude).toBe(false);
    expect(store.getPage(result.pageId)!.byClaude).toBe(true);
    expect(copy.byClaude).toBe(true);
  });

  it("puts only Claude's new pages in the inbox until they're kept", () => {
    const mine = store.createPage({ name: "Mine" });
    const result = store.addClaudePage("Claude's", [{ type: "text", x: 0, y: 0, label: "hi" }], null);
    if (!result.ok) throw new Error(result.errors.join());
    const before = store.getPage(result.pageId)!;
    expect(mine.inbox).toBe(false);
    expect(before.inbox).toBe(true);
    expect(store.duplicatePage(result.pageId, "Copy")!.inbox).toBe(false);

    const kept = store.keepPage(result.pageId)!;
    expect(kept.inbox).toBe(false);
    expect(kept.updatedAt).toBe(before.updatedAt);
    expect(store.keepPage("missing")).toBeNull();
  });

  it("saves for later and back without bumping updatedAt, keeping inbox pages it saves", () => {
    const a = store.createPage({ name: "A" });
    expect(a.savedAt).toBeNull();
    const saved = store.setPageSaved(a.id, true)!;
    expect(saved.savedAt).not.toBeNull();
    expect(saved.updatedAt).toBe(a.updatedAt);
    // Saving again keeps its place in the list.
    expect(store.setPageSaved(a.id, true)!.savedAt).toBe(saved.savedAt);
    expect(store.duplicatePage(a.id, "A copy")!.savedAt).toBeNull();
    expect(store.setPageSaved(a.id, false)!.savedAt).toBeNull();
    expect(store.setPageSaved("missing", true)).toBeNull();

    const result = store.addClaudePage("Claude's", [{ type: "text", x: 0, y: 0, label: "hi" }], null);
    if (!result.ok) throw new Error(result.errors.join());
    const fromInbox = store.setPageSaved(result.pageId, true)!;
    expect(fromInbox.inbox).toBe(false);
    expect(fromInbox.savedAt).not.toBeNull();
  });

  it("treats pages with a repo in an older backup as made by Claude", () => {
    const page = { createdAt: 1, updatedAt: 2, order: 0, elements: [], appState: {}, files: {} };
    store.putPages([
      { ...page, id: "a", name: "A", repo: "r" },
      { ...page, id: "b", name: "B" },
    ]);
    expect(store.getPage("a")!.byClaude).toBe(true);
    expect(store.getPage("b")!.byClaude).toBe(false);
  });

  it("deletes only the given page's files", () => {
    const a = store.createPage({ name: "A", elements: [image("shared")], files: files("shared") });
    const b = store.createPage({ name: "B", elements: [image("shared")], files: files("shared") });
    store.deletePage(a.id);
    expect(Object.keys(store.getPage(b.id)!.files)).toEqual(["shared"]);
  });

  it("renames", () => {
    const a = store.createPage({ name: "A" });
    const renamed = store.updatePageMeta(a.id, { name: "Renamed" })!;
    expect(renamed.name).toBe("Renamed");
    expect(renamed.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(store.updatePageMeta("missing", { name: "x" })).toBeNull();
  });

  it("pins and unpins without bumping updatedAt", () => {
    const a = store.createPage({ name: "A" });
    expect(a.pinnedAt).toBeNull();
    const pinned = store.setPagePinned(a.id, true)!;
    expect(pinned.pinnedAt).not.toBeNull();
    expect(pinned.updatedAt).toBe(a.updatedAt);
    // Pinning again keeps its place among the pins.
    expect(store.setPagePinned(a.id, true)!.pinnedAt).toBe(pinned.pinnedAt);
    expect(store.duplicatePage(a.id, "A copy")!.pinnedAt).toBeNull();
    expect(store.setPagePinned(a.id, false)!.pinnedAt).toBeNull();
    expect(store.setPagePinned("missing", true)).toBeNull();
  });

  it("restores pins, the inbox and saved for later from a backup", () => {
    const a = store.createPage({ name: "A" });
    const b = store.setPagePinned(store.createPage({ name: "B" }).id, true)!;
    const page = { elements: [], appState: {}, files: {} };
    store.putPages([
      { ...a, ...page, pinnedAt: 42, inbox: true, savedAt: 43 },
      { ...b, ...page, pinnedAt: null },
    ]);
    expect(store.getPage(a.id)!.pinnedAt).toBe(42);
    expect(store.getPage(a.id)!.inbox).toBe(true);
    expect(store.getPage(a.id)!.savedAt).toBe(43);
    expect(store.getPage(b.id)!.pinnedAt).toBeNull();
    expect(store.getPage(b.id)!.inbox).toBe(false);
    expect(store.getPage(b.id)!.savedAt).toBeNull();
  });

  it("putPages inserts new pages and overwrites existing ones by id", () => {
    const a = store.createPage({ name: "A", elements: [image("old")], files: files("old") });
    store.savePageView(a.id, { scrollX: 5, scrollY: 5, zoom: 1 });
    const keep = store.createPage({ name: "Keep" });
    store.putPages([
      { ...a, name: "A restored", elements: [image("new")], appState: {}, files: files("new") },
      { id: "fresh", name: "Fresh", createdAt: 1, updatedAt: 2, order: 9, elements: [], appState: {}, files: {} },
    ]);
    const restored = store.getPage(a.id)!;
    expect(restored.name).toBe("A restored");
    expect(Object.keys(restored.files)).toEqual(["new"]);
    expect(restored.view).toBeNull();
    expect(store.listPages().map((p) => p.name).sort()).toEqual(["A restored", "Fresh", "Keep"]);
    expect(store.getPage(keep.id)).not.toBeNull();
  });
});

describe("Store Claude edits", () => {
  it("creates a Claude page whose shapes wait in the queue", () => {
    const result = store.addClaudePage("Auth flow", [{ type: "rectangle", id: "a", x: 0, y: 0, label: "API" }, { type: "rectangle", x: 300, y: 0 }], "git@example.com:org/repo.git");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.addedIds[0]).toBe("a");
    expect(result.addedIds[1]).toMatch(/^c[0-9a-f]{10}$/);

    const page = store.readForClaude(result.pageId)!;
    expect(page.meta.repo).toBe("git@example.com:org/repo.git");
    expect(page.meta.byClaude).toBe(true);
    expect(page.meta.claude?.queued).toBe(1);
    expect(page.shapes.map((s) => s.id)).toEqual(result.addedIds);
    expect(page.shapes[0].label).toBe("API");
  });

  it("rejects an invalid new page without creating it", () => {
    const result = store.addClaudePage("Bad", [{ type: "rectangle" }], null);
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining("x and y are required")] });
    expect(store.listPages()).toEqual([]);
  });

  it("validates edits against the page including edits still queued", () => {
    const page = store.createPage({ name: "P", elements: [rect({ id: "a" }), rect({ id: "b" }), rect({ id: "c" })] });
    expect(store.queueEdit(page.id, { add: [{ id: "d", type: "ellipse", x: 0, y: 0 }] }).ok).toBe(true);
    // "d" only exists in the queue so far, but Claude can already refer to it.
    expect(store.queueEdit(page.id, { update: [{ id: "d", x: 50 }] }).ok).toBe(true);
    expect(store.queueEdit(page.id, { remove: ["zzz"] })).toEqual({ ok: false, errors: [expect.stringContaining('no element "zzz"')] });
    expect(store.queueEdit("missing", { remove: ["a"] }).ok).toBe(false);
    expect(store.readForClaude(page.id)!.shapes.find((s) => s.id === "d")?.x).toBe(50);
  });

  it("refuses an edit that removes more than half the page", () => {
    const page = store.createPage({ name: "P", elements: [rect({ id: "a" }), rect({ id: "b" }), rect({ id: "c" }), rect({ id: "d" })] });
    expect(store.queueEdit(page.id, { remove: ["a", "b"] }).ok).toBe(true); // exactly half is fine
    const result = store.queueEdit(page.id, { remove: ["c"] }); // 1 of the 2 left: fine
    expect(result.ok).toBe(true);
    const page2 = store.createPage({ name: "Q", elements: [rect({ id: "a" }), rect({ id: "b" }), rect({ id: "c" })] });
    const refused = store.queueEdit(page2.id, { remove: ["a", "b"] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.join()).toContain("use add_page");
  });

  it("applies queued edits with a snapshot, and reverts to it", () => {
    const page = store.createPage({ name: "P", elements: [rect({ id: "a" })] });
    store.queueEdit(page.id, { add: [{ id: "b", type: "rectangle", x: 200, y: 0 }] });
    const [queued] = store.getQueuedEdits(page.id);

    const applied = store.applyQueuedEdits(page.id, {
      editIds: [queued.id],
      elements: [rect({ id: "a" }), rect({ id: "b" })],
      baseUpdatedAt: page.updatedAt,
    });
    expect(applied).not.toBe("conflict");
    expect(applied && applied !== "conflict" && applied.claude).toEqual({ queued: 0, changedAt: expect.any(Number) });
    expect(store.getPage(page.id)!.elements.map((e) => e.id)).toEqual(["a", "b"]);

    const reverted = store.revertClaudeChange(page.id)!;
    expect(reverted.claude?.changedAt).toBeNull();
    expect(store.getPage(page.id)!.elements.map((e) => e.id)).toEqual(["a"]);
    expect(store.revertClaudeChange(page.id)).toBeNull(); // nothing left to revert
  });

  it("restores images Claude's change removed when reverting", () => {
    const page = store.createPage({ name: "P", elements: [image("f1"), rect({ id: "a" })], files: files("f1") });
    const imageId = store.getPage(page.id)!.elements[0].id;
    store.queueEdit(page.id, { remove: [imageId] });
    const [queued] = store.getQueuedEdits(page.id);
    store.applyQueuedEdits(page.id, { editIds: [queued.id], elements: [rect({ id: "a" })], baseUpdatedAt: page.updatedAt });
    expect(store.getPage(page.id)!.files).toEqual({});
    store.revertClaudeChange(page.id);
    expect(Object.keys(store.getPage(page.id)!.files)).toEqual(["f1"]);
  });

  it("rejects an apply when the page or its queue changed since it was read", () => {
    const page = store.createPage({ name: "P", elements: [rect({ id: "a" })] });
    store.queueEdit(page.id, { update: [{ id: "a", x: 5 }] });
    const [queued] = store.getQueuedEdits(page.id);
    store.savePageScene(page.id, { elements: [rect({ id: "a" })], appState: {}, files: {} }); // user saved meanwhile
    expect(store.applyQueuedEdits(page.id, { editIds: [queued.id], elements: [], baseUpdatedAt: page.updatedAt })).toBe("conflict");

    const fresh = store.getPage(page.id)!;
    expect(store.applyQueuedEdits(page.id, { editIds: [queued.id + 99], elements: [], baseUpdatedAt: fresh.updatedAt })).toBe("conflict");
    expect(store.getQueuedEdits(page.id)).toHaveLength(1);
  });

  it("reverts the newest queued edit first, then the last applied change", () => {
    const page = store.createPage({ name: "P", elements: [rect({ id: "a" })] });
    store.queueEdit(page.id, { update: [{ id: "a", x: 5 }] });
    const [first] = store.getQueuedEdits(page.id);
    store.applyQueuedEdits(page.id, { editIds: [first.id], elements: [rect({ id: "a", x: 5 })], baseUpdatedAt: page.updatedAt });
    store.queueEdit(page.id, { update: [{ id: "a", x: 9 }] });

    expect(store.revertLatestClaudeChange(page.id)).toBe("dropped-queued");
    expect(store.getQueuedEdits(page.id)).toEqual([]);
    expect(store.revertLatestClaudeChange(page.id)).toBe("reverted");
    expect(store.getPage(page.id)!.elements[0]).not.toHaveProperty("x", 5);
    expect(store.revertLatestClaudeChange(page.id)).toBe("nothing");
    expect(store.revertLatestClaudeChange("missing")).toBeNull();
  });

  it("finds pages by name, newest first, with element counts", () => {
    store.createPage({ name: "Auth flow", elements: [rect(), rect()] });
    store.createPage({ name: "Billing" });
    store.createPage({ name: "auth (old)" });
    expect(store.findPages("auth").map((p) => [p.name, p.elementCount])).toEqual([
      ["auth (old)", 0],
      ["Auth flow", 2],
    ]);
    expect(store.findPages()).toHaveLength(3);
  });
});

describe("Store on a shared file", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "meadowlark-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sees writes from another connection and bumps data_version for them", () => {
    const path = join(dir, "m.db");
    const app = new Store(openDb(path));
    const claude = new Store(openDb(path));
    const before = app.dataVersion();
    claude.addClaudePage("From Claude", [{ type: "text", x: 0, y: 0, label: "hi" }], null);
    expect(app.dataVersion()).not.toBe(before);
    expect(app.listPages().map((p) => p.name)).toEqual(["From Claude"]);
  });

  it("writes a consistent backup copy", () => {
    const path = join(dir, "m.db");
    const live = new Store(openDb(path));
    live.createPage({ name: "Kept" });
    live.backupTo(join(dir, "backup.db"));
    expect(new Store(openDb(join(dir, "backup.db"))).listPages().map((p) => p.name)).toEqual(["Kept"]);
  });
});
