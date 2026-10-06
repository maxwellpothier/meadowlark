import { useEffect, useRef, useState } from "react";
import type { PageMeta } from "../storage/types";
import { Menu } from "./Menu";
import { ClaudeIcon, MoreIcon, PinIcon } from "./icons";

interface PageItemProps {
  page: PageMeta;
  active: boolean;
  timeLabel: string;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onTogglePinned: (id: string) => void;
  onKeep: (id: string) => void;
  onToggleSaved: (id: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
}

export function PageItem(props: PageItemProps) {
  const { page, active, timeLabel } = props;
  const [editing, setEditing] = useState(false);
  const saved = !page.inbox && page.savedAt != null;
  // Pins only order the main list.
  const pinned = !page.inbox && !saved && page.pinnedAt != null;
  const saveForLater = { label: "Save for later", onSelect: () => props.onToggleSaved(page.id) };

  return (
    <li
      className={["page-item", active && "active", pinned && "pinned"].filter(Boolean).join(" ")}
      onClick={() => !editing && props.onSelect(page.id)}
      onDoubleClick={() => setEditing(true)}
      aria-current={active ? "page" : undefined}
      data-page-id={page.id}
    >
      {editing ? (
        <RenameInput
          initial={page.name}
          onDone={(name) => {
            setEditing(false);
            if (name !== null && name !== page.name) props.onRename(page.id, name);
          }}
        />
      ) : (
        <>
          <div className="page-text">
            <span className="page-name" title={page.byClaude ? `${page.name} (made by Claude)` : page.name}>
              {page.byClaude && <ClaudeIcon />}
              {page.name || "Untitled"}
            </span>
            <span className="page-time">
              {pinned && (
                <span className="page-pinned" title="Pinned" aria-label="Pinned">
                  <PinIcon />
                </span>
              )}
              {timeLabel}
            </span>
          </div>
          {(page.claude?.queued || page.claude?.changedAt != null) && (
            <span className="page-claude" title="Changed by Claude" aria-label="Changed by Claude" />
          )}
          <Menu
            className="page-menu"
            label={`Actions for ${page.name}`}
            trigger={<MoreIcon />}
            items={[
              ...(page.inbox
                ? [{ label: "Keep", onSelect: () => props.onKeep(page.id) }, saveForLater]
                : saved
                  ? [{ label: "Move to pages", onSelect: () => props.onToggleSaved(page.id) }]
                  : [{ label: pinned ? "Unpin" : "Pin to top", onSelect: () => props.onTogglePinned(page.id) }, saveForLater]),
              { label: "Rename", onSelect: () => setEditing(true) },
              { label: "Duplicate", onSelect: () => props.onDuplicate(page.id) },
              { label: "Export .excalidraw", onSelect: () => props.onExport(page.id) },
              { label: "Delete…", onSelect: () => props.onDelete(page.id), danger: true },
            ]}
          />
        </>
      )}
    </li>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const finish = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(name);
  };

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="rename-input"
      value={value}
      aria-label="Page name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value.trim() || initial);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value.trim() || initial)}
    />
  );
}
