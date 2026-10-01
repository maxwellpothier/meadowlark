import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageMeta, PageScene, PageView, StorageAdapter } from "../storage/types";
import { appState, files, hashElements, image, rect } from "../test/fixtures";
import { AutoSaver, type SaveStatus, type SceneSnapshot } from "./AutoSaver";

function fakeStorage() {
  const scenes: PageScene[] = [];
  const views: PageView[] = [];
  let fail = 0;
  const storage = {
    savePageScene: vi.fn(async (id: string, scene: PageScene) => {
      if (fail > 0) {
        fail--;
        throw new Error("disk full");
      }
      scenes.push(scene);
      return { id, name: "p", createdAt: 0, updatedAt: scenes.length, order: 0 } satisfies PageMeta;
    }),
    savePageView: vi.fn(async (_id: string, view: PageView) => {
      views.push(view);
    }),
  };
  return { storage: storage as unknown as StorageAdapter, scenes, views, failNext: (n = 1) => (fail = n), raw: storage };
}

function snapshot(elements = [rect()], overrides: Parameters<typeof appState>[0] = {}): SceneSnapshot {
  return { elements, appState: appState(overrides), files: {} };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function makeSaver(baseline: SceneSnapshot, extra: Partial<ConstructorParameters<typeof AutoSaver>[0]> = {}) {
  const fake = fakeStorage();
  const statuses: SaveStatus[] = [];
  const saved: PageMeta[] = [];
  const saver = new AutoSaver({
    pageId: "p1",
    storage: fake.storage,
    hashElements,
    baseline,
    onStatus: (s) => statuses.push(s),
    onSaved: (m) => saved.push(m),
    ...extra,
  });
  return { saver, statuses, saved, ...fake };
}

describe("AutoSaver", () => {
  it("does not save when nothing changed since load", async () => {
    const elements = [rect()];
    const { saver, raw } = makeSaver(snapshot(elements));
    saver.schedule(snapshot(elements)); // e.g. Excalidraw's initial onChange
    await vi.advanceTimersByTimeAsync(1000);
    expect(raw.savePageScene).not.toHaveBeenCalled();
    expect(raw.savePageView).not.toHaveBeenCalled();
  });

  it("debounces content changes", async () => {
    const { saver, scenes, saved } = makeSaver(snapshot([]));
    for (let i = 1; i <= 5; i++) {
      saver.schedule(snapshot(Array.from({ length: i }, () => rect())));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(scenes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(scenes).toHaveLength(1);
    expect(scenes[0].elements).toHaveLength(5);
    expect(saved).toHaveLength(1);
  });

  it("saves at least every maxWait during continuous editing", async () => {
    const { saver, scenes } = makeSaver(snapshot([]), { maxWaitMs: 2000 });
    for (let i = 1; i <= 30; i++) {
      saver.schedule(snapshot(Array.from({ length: i }, () => rect())));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(scenes.length).toBeGreaterThanOrEqual(1);
  });

  it("saves view-only changes without a scene write", async () => {
    const elements = [rect()];
    const { saver, raw, views } = makeSaver(snapshot(elements));
    saver.schedule(snapshot(elements, { scrollX: 50, zoom: { value: 2 } as never }));
    await saver.flush();
    expect(raw.savePageScene).not.toHaveBeenCalled();
    expect(views).toEqual([{ scrollX: 50, scrollY: 0, zoom: 2 }]);
  });

  it("only persists the safe appState fields", async () => {
    const { saver, scenes } = makeSaver(snapshot([]));
    saver.schedule(snapshot([rect()], { viewBackgroundColor: "#123456" }));
    await saver.flush();
    expect(scenes[0].appState).toEqual({
      viewBackgroundColor: "#123456",
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
    });
  });

  it("flush writes immediately and dispose flushes pending work", async () => {
    const { saver, scenes } = makeSaver(snapshot([]));
    saver.schedule(snapshot([rect()]));
    await saver.flush();
    expect(scenes).toHaveLength(1);

    saver.schedule(snapshot([rect(), rect()]));
    await saver.dispose();
    expect(scenes).toHaveLength(2);

    saver.schedule(snapshot([rect(), rect(), rect()])); // ignored after dispose
    await vi.advanceTimersByTimeAsync(1000);
    expect(scenes).toHaveLength(2);
  });

  it("cancel drops pending changes", async () => {
    const { saver, scenes } = makeSaver(snapshot([]));
    saver.schedule(snapshot([rect()]));
    saver.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    await saver.flush();
    expect(scenes).toHaveLength(0);
  });

  it("saves again when an image's data arrives after its element", async () => {
    const el = image("f1");
    const { saver, scenes } = makeSaver(snapshot([]));
    saver.schedule({ elements: [el], appState: appState(), files: {} });
    await saver.flush();
    saver.schedule({ elements: [el], appState: appState(), files: files("f1") });
    await saver.flush();
    expect(scenes).toHaveLength(2);
    expect(Object.keys(scenes[1].files)).toEqual(["f1"]);
  });

  it("retries after a failed save, even once disposed", async () => {
    const { saver, scenes, statuses, failNext } = makeSaver(snapshot([]), { retryMs: 1000 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    failNext();
    saver.schedule(snapshot([rect()]));
    await saver.dispose();
    expect(statuses).toContain("error");
    expect(scenes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scenes).toHaveLength(1);
    expect(statuses.at(-1)).toBe("saved");
  });
});
