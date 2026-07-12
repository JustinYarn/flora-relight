"use client";

import { useRef, useState } from "react";
import type { VideoAsset } from "@/lib/types";
import { Badge } from "@/components/ui";

/** Tiny corner tag overlaid on a video slot (Library-local mirror of the review pattern). */
function OverlayTag({ text }: { text: string }) {
  return (
    <span
      className="pointer-events-none absolute left-2 top-2 z-10 rounded px-1.5 py-0.5 text-2xs font-semibold tracking-wider text-ink"
      style={{ background: "color-mix(in srgb, var(--canvas) 78%, transparent)" }}
    >
      {text}
    </span>
  );
}

/**
 * Level-2 side-by-side players: original next to the shipped cut, click to
 * play both together. The original owns the audio; the relit side is always
 * muted (in mock mode it is literally the same track behind a CSS filter).
 */
export function PairPlayer({
  original,
  relit,
  relitLabel,
}: {
  original: VideoAsset;
  /** Undefined when this run never produced a relit cut. */
  relit?: VideoAsset;
  relitLabel: string;
}) {
  const originalRef = useRef<HTMLVideoElement | null>(null);
  const relitRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [relitBroken, setRelitBroken] = useState(false);

  const togglePlay = () => {
    const o = originalRef.current;
    if (!o) return;
    if (o.paused) {
      const r = relitRef.current;
      if (r) r.currentTime = o.currentTime;
      void o.play().catch(() => undefined);
      void relitRef.current?.play().catch(() => undefined);
    } else {
      o.pause();
      relitRef.current?.pause();
    }
  };

  const slotClass =
    "relative aspect-video overflow-hidden rounded-lg border border-edge bg-canvas";

  return (
    <button
      type="button"
      onClick={togglePlay}
      aria-label={playing ? "Pause both clips" : "Play both clips"}
      className="grid w-full max-w-3xl grid-cols-2 gap-2 text-left"
    >
      <span className={slotClass}>
        <video
          ref={originalRef}
          src={original.url}
          preload="metadata"
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => relitRef.current?.pause()}
          className="h-full w-full object-cover"
        />
        <OverlayTag text="ORIGINAL" />
      </span>
      <span className={slotClass}>
        {relit && !relitBroken ? (
          <>
            <video
              ref={relitRef}
              src={relit.url}
              preload="metadata"
              playsInline
              muted
              onError={() => setRelitBroken(true)}
              style={
                relit.simulatedFilter ? { filter: relit.simulatedFilter } : undefined
              }
              className="h-full w-full object-cover"
            />
            {relit.simulatedFilter ? (
              <span className="absolute bottom-2 left-2 z-10">
                <Badge color="var(--accent)">simulated</Badge>
              </span>
            ) : null}
          </>
        ) : (
          <span className="flex h-full w-full items-center justify-center text-2xs text-faint">
            {relitBroken ? "relit file missing" : "no relit cut yet"}
          </span>
        )}
        <OverlayTag text={relitLabel} />
      </span>
      <span className="col-span-2 text-center text-2xs text-faint">
        {playing ? "click to pause" : "click to play both — relit side muted"}
      </span>
    </button>
  );
}
