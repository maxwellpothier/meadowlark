import type { PageMeta } from "../storage/types";

export interface SidebarSections {
  pages: PageMeta[];
  inbox: PageMeta[];
  saved: PageMeta[];
}

/** Splits pages into the sidebar's sections: Claude's unkept pages, saved for later, and the rest. */
export function splitPages(pages: PageMeta[]): SidebarSections {
  const inbox = pages.filter((p) => p.inbox);
  const saved = pages.filter((p) => !p.inbox && p.savedAt != null);
  return {
    pages: sortPages(pages.filter((p) => !p.inbox && p.savedAt == null)),
    inbox: sortPages(inbox),
    // Most recently saved first; pins don't apply here.
    saved: saved.sort((a, b) => b.savedAt! - a.savedAt!),
  };
}

/** Pinned pages first, most recently pinned on top; then the rest, most recently changed first. */
export function sortPages(pages: PageMeta[]): PageMeta[] {
  return [...pages].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt);
}
