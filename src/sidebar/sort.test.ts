import { describe, expect, it } from "vitest";
import type { PageMeta } from "../storage/types";
import { sortPages, splitPages } from "./sort";

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

  it("splits pages into the main list, the inbox and saved for later", () => {
    const sections = splitPages([
      page("mine", 1),
      { ...page("pinned", 2, 10) },
      { ...page("inboxOld", 1), inbox: true },
      { ...page("inboxNew", 5), inbox: true },
      { ...page("savedFirst", 9, 30), savedAt: 10 },
      { ...page("savedLater", 1), savedAt: 20 },
      // An inbox page wins over a saved date, as the store never leaves both set.
      { ...page("both", 1), inbox: true, savedAt: 40 },
    ]);
    expect(sections.pages.map((p) => p.id)).toEqual(["pinned", "mine"]);
    expect(sections.inbox.map((p) => p.id)).toEqual(["inboxNew", "inboxOld", "both"]);
    expect(sections.saved.map((p) => p.id)).toEqual(["savedLater", "savedFirst"]);
  });
});
