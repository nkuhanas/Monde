import { useEffect } from "react";

export interface ConfirmationRequest {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm(): void | Promise<void>;
}

export function ConfirmationOverlay({ request, busy, onCancel, onConfirm }: {
  request: ConfirmationRequest | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel, request]);

  if (!request) return null;
  return (
    <div className="confirmation-overlay" onMouseDown={() => { if (!busy) onCancel(); }}>
      <section
        className="confirmation-card"
        data-tone={request.tone ?? "default"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-body"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirmation-mark" aria-hidden="true">!</div>
        <div className="confirmation-copy"><h2 id="confirmation-title">{request.title}</h2><p id="confirmation-body">{request.body}</p></div>
        <div className="confirmation-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{request.cancelLabel ?? "Cancel"}</button>
          <button className="confirmation-confirm" type="button" onClick={onConfirm} disabled={busy}>{busy ? "Working..." : request.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
