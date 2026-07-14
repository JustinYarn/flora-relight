"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import type { Run, VideoAsset } from "@/lib/types";

/**
 * "Download side-by-side" — asks the server to compose original + relit into
 * one comparison video (ffmpeg hstack, original audio) and downloads it.
 *
 * Exports the currently shipped cut: the final video when one exists,
 * otherwise the latest attempt with a real generated file. Simulated (mock)
 * attempts have no file on disk, so the button disables with a tooltip.
 * Busy/error handling mirrors ShareButton: label swap while working, a small
 * error line underneath on failure.
 */

/** Real relit files live under /api/media; simulated attempts don't. */
function isRealVideo(v: VideoAsset | undefined): v is VideoAsset {
  return Boolean(v && !v.simulatedFilter && v.url.startsWith("/api/media/"));
}

/**
 * Which cut to export: "final" when a real final video exists, else the
 * attempt number of the newest real generated video. The number comes from
 * the relit-v<N>.mp4 filename when possible (version numbers are whatever
 * the files say — salvaged runs included), falling back to the attempt index.
 */
function exportVersion(run: Run): number | "final" | null {
  if (isRealVideo(run.finalVideo)) return "final";
  for (let i = run.iterations.length - 1; i >= 0; i--) {
    const video = run.iterations[i].generatedVideo;
    if (!isRealVideo(video)) continue;
    const m = /relit-v(\d+)\.mp4$/.exec(video.url);
    return m ? Number(m[1]) : run.iterations[i].index;
  }
  return null;
}

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

  const version = exportVersion(run);

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
            ? "no generated video to download — simulated attempts have no file"
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
        title={version === null ? "no generated video yet" : undefined}
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
