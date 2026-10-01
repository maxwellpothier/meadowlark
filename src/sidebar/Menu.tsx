import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface MenuProps {
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  className?: string;
}

const ITEM_HEIGHT = 32;

/**
 * Minimal dropdown: click to open, click outside or Escape to close.
 * Fixed-positioned so it isn't clipped by the scrolling page list.
 */
export function Menu({ label, trigger, items, className }: MenuProps) {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const open = position !== null;
  const setOpen = (next: boolean) => {
    const rect = root.current?.getBoundingClientRect();
    if (!next || !rect) return setPosition(null);
    const height = items.length * ITEM_HEIGHT + 8;
    const flipUp = rect.bottom + height > window.innerHeight - 8;
    setPosition({
      position: "fixed",
      left: Math.max(8, rect.right - 180),
      ...(flipUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
  };
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setPosition(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPosition(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu ${className ?? ""}`} ref={root}>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className="menu-popover" role="menu" style={position}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
