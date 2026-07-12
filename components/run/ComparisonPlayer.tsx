"use client";

import { useEffect, useRef, useState } from "react";
import type { VideoAsset } from "@/lib/types";
import { Badge, Button, Card, SectionTitle } from "@/components/ui";
import { clamp, formatTime } from "@/lib/util";

type Mode = "side" | "wipe";

function Tag({ text, right = false }: { text: string; right?: boolean }) {
  return (
    <span
      className={`pointer-events-none absolute top-2 z-10 rounded px-1.5 py-0.5 text-2xs font-semibold tracking-wider text-ink ${
        right ? "right-2" : "left-2"
      }`}
      style={{ background: "color-mix(in srgb, var(--canvas) 78%, transparent)" }}
    >
      {text}
    </span>
  );
}

/**
 * Synced before/after player. In mock mode the "relit" element plays the SAME
 * source file with the iteration's simulated CSS filter on top — labeled
 * honestly. Audio always comes from the original element (the relit one is
 * muted; in mock it is literally the same track).
 */
export function ComparisonPlayer({
  original,
  relit,
  relitLabel,
}: {
  original: VideoAsset;
  /** Undefined while the selected iteration is still generating. */
  relit?: VideoAsset;
  relitLabel: string;
}) {
  const originalRef = useRef<HTMLVideoElement | null>(null);
  const relitRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<Mode>("side");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(original.durationSec);
  const [wipePos, setWipePos] = useState(50);

  // When the selected iteration changes, snap the (re)mounted relit element to
  // the primary's clock and resume if we were playing.
  useEffect(() => {
    const o = originalRef.current;
    const r = relitRef.current;
    if (!o || !r) return;
    r.currentTime = o.currentTime;
    if (!o.paused) void r.play().catch(() => undefined);
  }, [relit?.id]);

  const togglePlay = () => {
    const o = originalRef.current;
    if (!o) return;
    if (o.paused) {
      void o.play().catch(() => undefined);
      void relitRef.current?.play().catch(() => undefined);
    } else {
      o.pause();
      relitRef.current?.pause();
    }
  };

  const seek = (t: number) => {
    const clamped = clamp(t, 0, duration || original.durationSec);
    if (originalRef.current) originalRef.current.currentTime = clamped;
    if (relitRef.current) relitRef.current.currentTime = clamped;
    setTime(clamped);
  };

  const onTimeUpdate = () => {
    const o = originalRef.current;
    if (!o) return;
    setTime(o.currentTime);
    const r = relitRef.current;
    if (r && Math.abs(r.currentTime - o.currentTime) > 0.25) {
      r.currentTime = o.currentTime;
    }
  };

  const updateWipe = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setWipePos(clamp(((clientX - rect.left) / rect.width) * 100, 3, 97));
  };

  const side = mode === "side";
  const slotClass = side
    ? "relative aspect-video overflow-hidden rounded-lg border border-edge bg-canvas"
    : "absolute inset-0";

  return (
    <Card className="p-4">
      <SectionTitle
        right={
          <div className="flex gap-1 rounded-lg border border-edge bg-raised p-0.5">
            {(["side", "wipe"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${
                  mode === m ? "bg-surface text-ink" : "text-faint hover:text-muted"
                }`}
              >
                {m === "side" ? "Side by side" : "Wipe"}
              </button>
            ))}
          </div>
        }
      >
        Comparison
      </SectionTitle>

      <div
        ref={stageRef}
        className={
          side
            ? "grid grid-cols-2 gap-3"
            : "relative aspect-video overflow-hidden rounded-lg border border-edge bg-canvas"
        }
      >
        {/* ORIGINAL — the primary element; owns the clock and the audio. */}
        <div className={slotClass}>
          <video
            ref={originalRef}
            src={original.url}
            preload="auto"
            playsInline
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => relitRef.current?.pause()}
            onDurationChange={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setDuration(d);
            }}
            className="h-full w-full object-cover"
          />
          <Tag text="ORIGINAL" right={!side} />
        </div>

        {/* RELIT — same pixels + simulated filter in mock mode; always muted. */}
        <div
          className={slotClass}
          style={side ? undefined : { clipPath: `inset(0 ${100 - wipePos}% 0 0)` }}
        >
          {relit ? (
            <video
              ref={relitRef}
              src={relit.url}
              preload="auto"
              playsInline
              muted
              style={relit.simulatedFilter ? { filter: relit.simulatedFilter } : undefined}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full animate-pulse items-center justify-center bg-raised text-2xs text-faint">
              generating…
            </div>
          )}
          <Tag text={relitLabel} />
          {relit?.simulatedFilter ? (
            <span className="absolute bottom-2 left-2 z-10">
              <Badge color="var(--accent)">simulated (mock)</Badge>
            </span>
          ) : null}
        </div>

        {/* Wipe divider handle */}
        {!side && (
          <div
            className="absolute inset-y-0 z-20 flex w-6 -translate-x-1/2 cursor-ew-resize items-center justify-center"
            style={{ left: `${wipePos}%`, touchAction: "none" }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              updateWipe(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) updateWipe(e.clientX);
            }}
            role="slider"
            aria-label="Wipe divider"
            aria-valuenow={Math.round(wipePos)}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setWipePos((p) => clamp(p - 2, 3, 97));
              if (e.key === "ArrowRight") setWipePos((p) => clamp(p + 2, 3, 97));
            }}
          >
            <div className="h-full w-0.5 bg-accent" />
            <div className="absolute top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-edge bg-raised text-2xs text-muted">
              ↔
            </div>
          </div>
        )}
      </div>

      {/* Transport: one clock drives both elements. */}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="ghost" onClick={togglePlay} className="w-20">
          {playing ? "Pause" : "Play"}
        </Button>
        <span className="w-10 text-right text-2xs tabular-nums text-muted">
          {formatTime(time)}
        </span>
        <input
          type="range"
          min={0}
          max={duration || original.durationSec}
          step={0.05}
          value={Math.min(time, duration || original.durationSec)}
          onChange={(e) => seek(Number(e.target.value))}
          className="flex-1 accent-accent"
          aria-label="Scrub timeline"
        />
        <span className="w-10 text-2xs tabular-nums text-faint">{formatTime(duration)}</span>
      </div>
      <p className="mt-2 text-2xs text-faint">
        Audio: original track (remuxed verbatim — SHA-256 verified) · relit player muted
      </p>
    </Card>
  );
}
