import { memo, useEffect, useMemo, useState } from "react";
import type { SaveStatus } from "../editor/AutoSaver";
import type { PageMeta } from "../storage/types";
import { CollapseIcon, ExpandIcon, ImportIcon, MoreIcon, PlusIcon, SearchIcon } from "./icons";
import { Menu } from "./Menu";
import { PageItem } from "./PageItem";
import { sortPages } from "./sort";

export interface SidebarActions {
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: () => void;
  onExportAll: () => void;
  onRestore: () => void;
  onToggleCollapsed: () => void;
}

interface SidebarProps {
  pages: PageMeta[];
  activeId: string | null;
  collapsed: boolean;
  status: SaveStatus;
  actions: SidebarActions;
}

export function Sidebar({ pages, activeId, collapsed, status, actions }: SidebarProps) {
  const [query, setQuery] = useState("");

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button
          type="button"
          className="icon-button"
          aria-label="Show pages"
          title="Show pages"
          onClick={actions.onToggleCollapsed}
        >
          <ExpandIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <span className="sidebar-title">Pages</span>
        <div className="sidebar-header-actions">
          <button type="button" className="icon-button" aria-label="New page" title="New page" onClick={actions.onCreate}>
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Import .excalidraw file"
            title="Import .excalidraw file"
            onClick={actions.onImport}
          >
            <ImportIcon />
          </button>
          <Menu
            label="Backup and restore"
            trigger={<MoreIcon />}
            items={[
              { label: "Export all (backup)", onSelect: actions.onExportAll },
              { label: "Restore from backup…", onSelect: actions.onRestore },
            ]}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Hide pages"
            title="Hide pages"
            onClick={actions.onToggleCollapsed}
          >
            <CollapseIcon />
          </button>
        </div>
      </header>

      <div className="sidebar-controls">
        <label className="search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </label>
      </div>

      <PageList pages={pages} activeId={activeId} query={query} actions={actions} />

      <footer className="sidebar-footer">
        <span className={`save-status ${status}`}>{STATUS_LABEL[status]}</span>
        <span className="page-count">
          {pages.length} {pages.length === 1 ? "page" : "pages"}
        </span>
      </footer>
    </aside>
  );
}

const STATUS_LABEL: Record<SaveStatus, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  error: "Save failed, retrying",
};

interface PageListProps {
  pages: PageMeta[];
  activeId: string | null;
  query: string;
  actions: SidebarActions;
}

// Memoized so save-status updates don't re-render every row.
const PageList = memo(function PageList({ pages, activeId, query, actions }: PageListProps) {
  const now = useNow(60_000);

  const sorted = useMemo(() => sortPages(pages), [pages]);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? sorted.filter((p) => p.name.toLowerCase().includes(needle)) : sorted),
    [sorted, needle],
  );
  if (visible.length === 0) {
    return <div className="page-list-empty">{needle ? "No pages match." : "No pages yet."}</div>;
  }

  return (
    <ul className="page-list">
      {visible.map((page) => (
        <PageItem
          key={page.id}
          page={page}
          active={page.id === activeId}
          timeLabel={relativeTime(page.updatedAt, now)}
          onSelect={actions.onSelect}
          onRename={actions.onRename}
          onDuplicate={actions.onDuplicate}
          onExport={actions.onExport}
          onDelete={actions.onDelete}
        />
      ))}
    </ul>
  );
});

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relativeTime(ts: number, now: number): string {
  const seconds = Math.round((ts - now) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return rtf.format(days, "day");
  return new Date(ts).toLocaleDateString();
}
