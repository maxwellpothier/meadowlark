import { describe, expect, it } from "vitest";
import type { PageMeta } from "../storage/types";
import { sortPages } from "./sort";

const page = (id: string, updatedAt: number, pinnedAt?: number | null): PageMeta => ({
  id,
  name: id,
  createdAt: 0,
  updatedAt,
  order: 0,
  pinnedAt,
});

describe("sortPages", () => {
  it("puts pinned pages first, newest pin on top, then the rest by last change", () => {
    const sorted = sortPages([page("old", 1), page("pinnedFirst", 2, 10), page("new", 5), page("pinnedLater", 1, 20), page("unpinned", 3, null)]);
    expect(sorted.map((p) => p.id)).toEqual(["pinnedLater", "pinnedFirst", "new", "unpinned", "old"]);
  });
});
