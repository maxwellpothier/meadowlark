import type { PageMeta } from "../storage/types";

/** Most recently changed first. */
export function sortPages(pages: PageMeta[]): PageMeta[] {
  return [...pages].sort((a, b) => b.updatedAt - a.updatedAt);
}
