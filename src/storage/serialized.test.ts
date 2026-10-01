import { describe, expect, it } from "vitest";
import { serialized } from "./serialized";
import type { PageMeta, StorageAdapter } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("serialized", () => {
  it("runs a read issued after a save only once that save has landed", async () => {
    const save = deferred<PageMeta | null>();
    const calls: string[] = [];
    const s = serialized({
      savePageScene: () => {
        calls.push("save:start");
        return save.promise.then((m) => (calls.push("save:end"), m));
      },
      getPage: async () => {
        calls.push("get");
        return null;
      },
    } as unknown as StorageAdapter);
    const saving = s.savePageScene("p", { elements: [], appState: {}, files: {} });
    const read = s.getPage("p"); // issued synchronously after, without awaiting
    expect(calls).toEqual(["save:start"]);
    save.resolve(null);
    await Promise.all([saving, read]);
    expect(calls).toEqual(["save:start", "save:end", "get"]);
  });

  it("starts a call synchronously when idle, and queues it otherwise", async () => {
    const calls: string[] = [];
    const s = serialized({
      listPages: async () => {
        calls.push("list");
        return [];
      },
      getPage: async (id: string) => {
        calls.push(`get:${id}`);
        return null;
      },
    } as unknown as StorageAdapter);
    const first = s.listPages();
    expect(calls).toEqual(["list"]); // synchronous: matters for beforeunload
    const second = s.getPage("x");
    expect(calls).toEqual(["list"]); // queued behind the first
    await Promise.all([first, second]);
    expect(calls).toEqual(["list", "get:x"]);
  });

  it("keeps going after a failed call", async () => {
    const s = serialized({
      listPages: () => Promise.reject(new Error("boom")),
      createPage: async (input: { name: string }) => ({ id: "1", name: input.name, createdAt: 0, updatedAt: 0, order: 0 }),
    } as unknown as StorageAdapter);
    await expect(s.listPages()).rejects.toThrow("boom");
    expect(await s.createPage({ name: "after" })).toMatchObject({ name: "after" });
  });
});
