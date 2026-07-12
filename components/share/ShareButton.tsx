"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { buildShareSnapshot } from "@/lib/share";
import type { Run } from "@/lib/types";

/**
 * "Share snapshot" — compiles the run into one self-contained HTML file
 * (lib/share.ts) and downloads it. Everything is handled internally: busy
 * state while the video is fetched and base64-encoded, and a small error
 * line underneath when embedding fails (clip too large, dead object URL).
 */
export function ShareButton({ run }: { run: Run }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const share = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const html = await buildShareSnapshot(run);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `relight-review-${run.id.slice(0, 14)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on a delay — revoking synchronously can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't build the snapshot — try again."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="ghost" disabled={busy} onClick={() => void share()}>
        {busy ? "Building snapshot…" : "Share snapshot"}
      </Button>
      {error ? (
        <p className="max-w-[260px] text-right text-2xs leading-relaxed text-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}
