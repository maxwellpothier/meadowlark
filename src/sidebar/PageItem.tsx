import { useEffect, useRef, useState } from "react";
import type { PageMeta } from "../storage/types";
import { Menu } from "./Menu";
import { ClaudeIcon, MoreIcon } from "./icons";

interface PageItemProps {
  page: PageMeta;
  active: boolean;
  timeLabel: string;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
}

export function PageItem(props: PageItemProps) {
  const { page, active, timeLabel } = props;
  const [editing, setEditing] = useState(false);

  return (
    <li
      className={active ? "page-item active" : "page-item"}
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
            <span className="page-time">{timeLabel}</span>
          </div>
          {(page.claude?.queued || page.claude?.changedAt != null) && (
            <span className="page-claude" title="Changed by Claude" aria-label="Changed by Claude" />
          )}
          <Menu
            className="page-menu"
            label={`Actions for ${page.name}`}
            trigger={<MoreIcon />}
            items={[
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
