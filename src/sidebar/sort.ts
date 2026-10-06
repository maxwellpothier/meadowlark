import type { PageMeta } from "../storage/types";

/** Pinned pages first, most recently pinned on top; then the rest, most recently changed first. */
export function sortPages(pages: PageMeta[]): PageMeta[] {
  return [...pages].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt);
}
