import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const ImportIcon = () => (
  <Icon>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Icon>
);
export const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Icon>
);
export const CollapseIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 10l-2 2 2 2" />
  </Icon>
);
export const ExpandIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M13 10l2 2-2 2" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </Icon>
);

// Claude's spark: rays of uneven length from a shared centre, in Claude's orange.
const SPARK_RAYS = [10, 8, 9.5, 7.5, 10, 8.5, 9, 7.5, 10, 8, 9.5, 8.5];
export const ClaudeIcon = () => (
  <svg className="icon claude-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <g stroke="#d97757" strokeWidth="2.4" strokeLinecap="round">
      {SPARK_RAYS.map((r, i) => {
        const a = (i / SPARK_RAYS.length) * 2 * Math.PI - Math.PI / 2;
        return <line key={i} x1="12" y1="12" x2={12 + r * Math.cos(a)} y2={12 + r * Math.sin(a)} />;
      })}
    </g>
  </svg>
);
