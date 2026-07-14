"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Run, VideoAsset } from "@/lib/types";
import { Badge } from "@/components/ui";
import { clamp, formatTime } from "@/lib/util";

/** Tiny corner tag overlaid on a video slot. */
function OverlayTag({ text, right = false }: { text: string; right?: boolean }) {
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
 * The screen's single idea: original next to relit, large and quiet.
 *
 * Sync pattern carried over from the legacy ComparisonPlayer: the ORIGINAL
 * element owns the clock and the audio; the relit element is muted (in mock
 * mode it is literally the same track) and is re-snapped whenever it drifts
 * past 0.25s, on every seek, and on attempt switch.
 *
 * Real live runs ship a 1080p original next to a 720p relit whose duration
 * differs slightly (10.07s vs 10.00s) — the transport clamps everything to
 * min(durations) and either element ending stops both, so the pair can never
 * desync at the tail.
 */
export function HeroComparison({
  original,
  relit,
  relitLabel,
  fallback,
  generating,
}: {
  original: VideoAsset;
  /** Undefined while the selected attempt is still generating. */
  relit?: VideoAsset;
  relitLabel: string;
  fallback?: Run["fallback"];
  /** Rendered in the relit slot while `relit` is undefined (the theater). */
  generating?: ReactNode;
}) {
  const originalRef = useRef<HTMLVideoElement | null>(null);
  const relitRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [wipe, setWipe] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [origDuration, setOrigDuration] = useState<number | null>(null);
  const [relitDuration, setRelitDuration] = useState<number | null>(null);
  const [origError, setOrigError] = useState<string | null>(null);
  const [relitError, setRelitError] = useState<string | null>(null);
  const [wipePos, setWipePos] = useState(50);
  /** Consecutive relit self-heal attempts (reset once it actually plays). */
  const relitHealsRef = useRef(0);

  // Playable window: both elements are clamped to the SHORTER of the two
  // durations (real runs differ by a few frames), falling back to metadata.
  const origDur = origDuration ?? original.durationSec;
  const duration =
    relit && relitDuration !== null && Number.isFinite(relitDuration)
      ? Math.min(origDur, relitDuration)
      : origDur;

  // Src change (attempt switch / final swap): stale-src is the top playback
  // suspect — imperatively reload BOTH elements and reset the transport.
  useEffect(() => {
    const o = originalRef.current;
    const r = relitRef.current;
    setPlaying(false);
    setTime(0);
    setOrigError(null);
    setRelitError(null);
    setRelitDuration(null);
    relitHealsRef.current = 0;
    if (o) {
      o.pause();
      o.load();
    }
    if (r) {
      r.pause();
      r.load();
    }
  }, [original.url, relit?.url]);

  const stopBoth = () => {
    originalRef.current?.pause();
    relitRef.current?.pause();
    setPlaying(false);
  };

  const seek = (t: number) => {
    const clamped = clamp(t, 0, duration || original.durationSec);
    if (originalRef.current) originalRef.current.currentTime = clamped;
    const r = relitRef.current;
    if (r && r.readyState >= 1) r.currentTime = clamped;
    setTime(clamped);
  };

  const togglePlay = () => {
    const o = originalRef.current;
    if (!o) return;
    if (o.paused) {
      // At the tail? Restart from the top instead of playing a dead frame.
      if (duration > 0 && o.currentTime >= duration - 0.05) seek(0);
      void o.play().catch(() => undefined);
      void relitRef.current?.play().catch(() => undefined);
    } else {
      stopBoth();
    }
  };

  /** Snap the relit clock to the original's (drift, seek, remount). */
  const snapRelit = () => {
    const o = originalRef.current;
    const r = relitRef.current;
    if (!o || !r || r.readyState < 1) return;
    if (Math.abs(r.currentTime - o.currentTime) > 0.01) r.currentTime = o.currentTime;
  };

  /**
   * The relit element FOLLOWS the original. Browsers sometimes refuse or drop
   * a play() that lands mid-seek (observed in Chrome on replay-from-the-tail:
   * the relit gets a UA-initiated pause while the original rolls on). If the
   * relit pauses while the original is playing, re-snap and re-issue play() —
   * capped so a genuinely broken file can't cause a play/pause fight.
   */
  const onRelitPause = () => {
    const o = originalRef.current;
    const r = relitRef.current;
    if (!o || !r || o.paused || o.ended || r.ended) return;
    if (relitHealsRef.current >= 4) return;
    relitHealsRef.current += 1;
    if (r.readyState >= 1) r.currentTime = o.currentTime;
    void r.play().catch(() => undefined);
  };

  const onTimeUpdate = () => {
    const o = originalRef.current;
    if (!o) return;
    // Auto-stop at min(durations): the longer original must not play past the
    // relit's tail — one side ending alone is exactly the desync bug.
    if (duration > 0 && o.currentTime >= duration - 0.05 && !o.paused) {
      stopBoth();
      setTime(duration);
      return;
    }
    setTime(o.currentTime);
    const r = relitRef.current;
    if (r && r.readyState >= 1 && Math.abs(r.currentTime - o.currentTime) > 0.25) {
      r.currentTime = o.currentTime;
    }
  };

  /** Avoid poster-less black first frames: nudge off t=0 once metadata lands. */
  const primeFirstFrame = (v: HTMLVideoElement) => {
    if (v.paused && v.currentTime < 0.01) v.currentTime = 0.01;
  };

  const updateWipe = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setWipePos(clamp(((clientX - rect.left) / rect.width) * 100, 3, 97));
  };

  const mediaError = origError ?? relitError;

  const side = !wipe;
  const slotClass = side
    ? "relative aspect-video overflow-hidden rounded-xl bg-canvas outline outline-1 -outline-offset-1 outline-white/10"
    : "absolute inset-0";

  return (
    <section>
      <div
        ref={stageRef}
        className={
          side
            ? "grid grid-cols-2 gap-2"
            : "relative aspect-video overflow-hidden rounded-xl bg-canvas outline outline-1 -outline-offset-1 outline-white/10"
        }
      >
        {/* ORIGINAL — primary element; owns the clock and the audio. */}
        <div className={slotClass}>
          <video
            ref={originalRef}
            src={original.url}
            preload="auto"
            playsInline
            onTimeUpdate={onTimeUpdate}
            onSeeked={snapRelit}
            onPlay={() => {
              setPlaying(true);
              void relitRef.current?.play().catch(() => undefined);
            }}
            onPause={() => {
              setPlaying(false);
              relitRef.current?.pause();
            }}
            onEnded={stopBoth}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setOrigDuration(d);
              primeFirstFrame(e.currentTarget);
            }}
            onDurationChange={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setOrigDuration(d);
            }}
            onCanPlay={() => setOrigError(null)}
            onError={() =>
              setOrigError("original video failed to load — check the file in data/runs/…")
            }
            onStalled={(e) => {
              if (e.currentTarget.readyState < 3)
                setOrigError(
                  "original video stalled while loading — check the file in data/runs/…"
                );
            }}
            className="h-full w-full object-cover"
          />
          <OverlayTag text="ORIGINAL" right={!side} />
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
              preload="metadata"
              playsInline
              muted
              onEnded={stopBoth}
              onPause={onRelitPause}
              onPlaying={() => {
                relitHealsRef.current = 0;
              }}
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d) && d > 0) setRelitDuration(d);
                primeFirstFrame(e.currentTarget);
              }}
              onDurationChange={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d) && d > 0) setRelitDuration(d);
              }}
              onCanPlay={() => setRelitError(null)}
              onError={() =>
                setRelitError("relit video failed to load — check the file in data/runs/…")
              }
              onStalled={(e) => {
                if (e.currentTarget.readyState < 3)
                  setRelitError(
                    "relit video stalled while loading — check the file in data/runs/…"
                  );
              }}
              style={relit.simulatedFilter ? { filter: relit.simulatedFilter } : undefined}
              className="h-full w-full object-cover"
            />
          ) : (
            (generating ?? (
              <div className="flex h-full w-full animate-pulse items-center justify-center bg-raised text-2xs text-faint">
                generating…
              </div>
            ))
          )}
          <OverlayTag text={relitLabel} />
          {relit?.simulatedFilter ? (
            <span className="absolute bottom-2 left-2 z-10">
              <Badge color="var(--accent)">simulated (mock)</Badge>
            </span>
          ) : null}
        </div>

        {/* Wipe divider handle */}
        {!side && (
          <div
            className="absolute inset-y-0 z-20 flex w-10 -translate-x-1/2 cursor-ew-resize items-center justify-center"
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
        <button
          onClick={togglePlay}
          className="min-h-10 w-16 rounded-lg border border-edge px-3 py-1 text-sm text-muted transition-[transform,color,border-color] duration-150 ease-out hover:border-faint hover:text-ink active:scale-[0.96]"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span className="w-10 text-right text-2xs tabular-nums text-muted">
          {formatTime(Math.min(time, duration))}
        </span>
        <input
          type="range"
          min={0}
          max={duration || original.durationSec}
          step={0.05}
          value={Math.min(time, duration || original.durationSec)}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-10 flex-1 accent-accent"
          aria-label="Scrub timeline"
        />
        <span className="w-10 text-2xs tabular-nums text-faint">{formatTime(duration)}</span>
        <button
          onClick={() => setWipe((w) => !w)}
          aria-pressed={wipe}
          className={`min-h-10 rounded-lg border px-3 py-1 text-sm transition-[transform,color,border-color] duration-150 ease-out active:scale-[0.96] ${
            wipe
              ? "border-faint text-ink"
              : "border-edge text-muted hover:border-faint hover:text-ink"
          }`}
        >
          Wipe
        </button>
      </div>

      {mediaError ? (
        <p className="mt-2 text-center text-2xs text-fail">{mediaError}</p>
      ) : null}

      <p
        className="mt-2 text-center text-2xs text-faint"
        title="original audio restored (remuxed bit-exact)"
      >
        Audio: original track restored, untouched
        {fallback?.applied ? (
          <span className="text-borderline">
            {" "}
            · safe fallback — lighting copied onto the original pixels ({fallback.reason})
          </span>
        ) : null}
      </p>
    </section>
  );
}
