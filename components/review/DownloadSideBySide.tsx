"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import type { Run } from "@/lib/types";
import { isApprovedPlanNoOp } from "@/lib/workflow-mode";
import { sideBySideExportVersion } from "@/components/review/export-selection";

/**
 * "Download side-by-side" — asks the server to compose original + relit into
 * one comparison video (ffmpeg hstack, original audio) and downloads it.
 *
 * Exports the currently shipped cut: the final video when one exists,
 * otherwise the latest attempt with a real generated file. Simulated (mock)
 * attempts have no file on disk, so the button disables with a tooltip.
 * The label changes while the export is being built, and a small error line
 * appears underneath on failure.
 */

export function DownloadSideBySide({
  run,
  variant = "default",
}: {
  run: Run;
  /** "compact" renders a small ↓ icon-button for dense rows (Library). */
  variant?: "default" | "compact";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const version = sideBySideExportVersion(run);
  const unavailableReason = isApprovedPlanNoOp(run)
    ? "This approved no-op has no generated after-video to compose."
    : "No delivered generated video is available yet.";

  const download = async () => {
    if (busy || version === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/export/side-by-side", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id, version }),
      });
      const data = (await res.json().catch(() => null)) as {
        url?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.url) {
        throw new Error(data?.error ?? "Couldn't build the comparison video — try again.");
      }
      // The export is named side-by-side-v<N>.mp4 — pull N back out so the
      // downloaded filename carries the attempt number even for "final".
      const m = /side-by-side-v(\d+)\.mp4$/.exec(data.url);
      const attempt = m ? m[1] : String(version);
      const a = document.createElement("a");
      a.href = data.url;
      a.download = `relight-side-by-side-attempt-${attempt}-${run.id.slice(0, 14)}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't build the comparison video — try again."
      );
    } finally {
      setBusy(false);
    }
  };

  if (variant === "compact") {
    return (
      <button
        disabled={busy || version === null}
        onClick={() => void download()}
        aria-label="Download side-by-side video"
        title={
          version === null
            ? unavailableReason
            : (error ?? "Download side-by-side video")
        }
        className={`min-h-10 min-w-10 rounded-md border border-edge px-2 py-1 text-xs transition-[transform,color,border-color] duration-150 ease-out hover:border-faint active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${
          error ? "text-fail" : "text-muted hover:text-ink"
        }`}
      >
        {busy ? "…" : "↓"}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        disabled={busy || version === null}
        title={version === null ? unavailableReason : undefined}
        onClick={() => void download()}
      >
        {busy ? "Preparing video…" : "Download side-by-side"}
      </Button>
      {error ? (
        <p className="max-w-[260px] text-right text-2xs leading-relaxed text-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}
