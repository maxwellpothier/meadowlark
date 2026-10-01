import { useEffect, useRef, type ReactNode } from "react";

// In-page replacement for window.confirm/alert, styled to match the app.
// Use it through useDialogs().

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

export interface DialogRequest extends ConfirmOptions {
  /** null = notice with a single button. */
  cancelLabel: string | null;
  resolve: (ok: boolean) => void;
}

export function Dialog({ request, onClose }: { request: DialogRequest; onClose: (ok: boolean) => void }) {
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{request.title}</h2>
        {request.message && <div className="dialog-message">{request.message}</div>}
        <div className="dialog-actions">
          {request.cancelLabel && (
            <button type="button" className="button" onClick={() => onClose(false)}>
              {request.cancelLabel}
            </button>
          )}
          <button
            type="button"
            ref={confirmButton}
            className={`button primary${request.danger ? " danger" : ""}`}
            onClick={() => onClose(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
