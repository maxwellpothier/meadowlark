import type { PageMeta } from "../storage/types";

export interface ClaudeBannerActions {
  onApply: () => void;
  onDiscard: () => void;
  onRevert: () => void;
  onKeep: () => void;
}

/**
 * Shown over the open page when Claude has changes waiting for it (which
 * apply only when you say so, since you're looking at the page), or when
 * Claude changed it since you last acknowledged.
 */
export function ClaudeBanner({ page, busy, actions }: { page: PageMeta; busy: boolean; actions: ClaudeBannerActions }) {
  const queued = page.claude?.queued ?? 0;
  const changed = page.claude?.changedAt != null;
  if (!queued && !changed) return null;

  return (
    <div className="claude-banner" role="status">
      {queued ? (
        <>
          <span>Claude has {queued === 1 ? "a change" : `${queued} changes`} for this page.</span>
          <button type="button" className="button" disabled={busy} onClick={actions.onDiscard}>
            Discard
          </button>
          <button type="button" className="button primary" disabled={busy} onClick={actions.onApply}>
            Apply
          </button>
        </>
      ) : (
        <>
          <span>Claude changed this page.</span>
          <button type="button" className="button" disabled={busy} onClick={actions.onRevert}>
            Revert
          </button>
          <button type="button" className="button primary" disabled={busy} onClick={actions.onKeep}>
            Keep
          </button>
        </>
      )}
    </div>
  );
}
