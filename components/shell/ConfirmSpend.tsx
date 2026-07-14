"use client";

/**
 * Minimal spend-confirmation modal — used ONLY in live mode, where a click
 * costs real API dollars. Mock mode never renders this: nothing is spent,
 * so nothing needs confirming. No portal, no new deps; a fixed overlay is
 * fine at this app's z-scale.
 */

import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui";

export function ConfirmSpend({
  title,
  lines,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  confirmDisabled = false,
  error,
  children,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
  /** Optional extra controls (e.g. a batch budget input) rendered above the buttons. */
  children?: ReactNode;
}) {
  // Escape cancels — the cheapest way out of an accidental spend.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={() => {
        if (!busy) onCancel();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-edge bg-surface p-6"
      >
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <ul className="mt-3 flex flex-col gap-1.5">
          {lines.map((line, i) => (
            <li key={i} className="text-sm leading-relaxed text-muted">
              {line}
            </li>
          ))}
        </ul>
        {error ? (
          <p className="mt-3 text-xs leading-relaxed text-fail" role="alert">
            {error}
          </p>
        ) : null}
        {children ? <div className="mt-4">{children}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? "Saving work…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
