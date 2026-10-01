import { useCallback, useState, type ReactNode } from "react";
import { Dialog, type ConfirmOptions, type DialogRequest } from "./Dialog";

/** confirm()/notify() that render an in-page dialog. Render `element` once. */
export function useDialogs() {
  const [request, setRequest] = useState<DialogRequest | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, cancelLabel: "Cancel", resolve })),
    [],
  );
  const notify = useCallback(
    (title: string, message?: ReactNode) =>
      new Promise<void>((resolve) =>
        setRequest({ title, message, confirmLabel: "OK", cancelLabel: null, resolve: () => resolve() }),
      ),
    [],
  );

  const close = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };
  const element = request ? <Dialog request={request} onClose={close} /> : null;
  return { confirm, notify, element };
}
