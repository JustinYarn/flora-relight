"use client";

/**
 * Client-only canvas utilities for probing videos and extracting frames.
 *
 * In mock mode these do double duty: `extractFrames` with a `cssFilter`
 * simulates what a *generated* video's frames would look like (the mock
 * providers point the generated asset at the original file plus a filter).
 * When real APIs land, the same functions sample the actual generated file
 * and the filter argument simply goes unused.
 */

import type { FrameSample } from "@/lib/types";
import { sleep } from "@/lib/util";

interface AudioProbeElement extends HTMLVideoElement {
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
  audioTracks?: { length: number };
}

const MIN_SEEK_SEC = 0.1; // seeking to exactly 0 is unreliable across browsers

function createVideoElement(url: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = url;
  return video;
}

function releaseVideoElement(video: HTMLVideoElement): void {
  video.removeAttribute("src");
  video.load();
}

/** Wait for one event on a video element, rejecting on error or timeout. */
function waitForEvent(
  video: HTMLVideoElement,
  event: string,
  timeoutMs = 8000
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`Video element errored while waiting for "${event}"`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for video "${event}" event`));
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
    }
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/**
 * Best-effort audio detection. None of the three signals is standard across
 * every browser, so when nothing is detectable we default to TRUE — a false
 * "has audio" only costs a no-op remux, a false "no audio" would silently
 * drop the user's voice track.
 */
function detectAudio(video: HTMLVideoElement): boolean {
  const probe = video as AudioProbeElement;
  if (typeof probe.mozHasAudio === "boolean") return probe.mozHasAudio;
  if (
    typeof probe.webkitAudioDecodedByteCount === "number" &&
    probe.webkitAudioDecodedByteCount > 0
  ) {
    return true;
  }
  if (probe.audioTracks && typeof probe.audioTracks.length === "number") {
    return probe.audioTracks.length > 0;
  }
  return true;
}

/** Read duration, dimensions, and (best-effort) audio presence from a video URL. */
export async function probeVideo(url: string): Promise<{
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}> {
  const video = createVideoElement(url);
  try {
    await waitForEvent(video, "loadedmetadata");
    const d = video.duration;
    return {
      // MediaRecorder webm can report Infinity/NaN — return 0; the player has its own onDurationChange fallback.
      durationSec: !Number.isFinite(d) || d <= 0 ? 0 : d,
      width: video.videoWidth,
      height: video.videoHeight,
      hasAudio: detectAudio(video),
    };
  } finally {
    releaseVideoElement(video);
  }
}

/**
 * Extract JPEG frames at the given timestamps. Seeks are serialized on a
 * single hidden <video> element (concurrent seeks on one element race and
 * return stale frames). `cssFilter` is applied via ctx.filter — in mock mode
 * this is how the "generated" look is simulated.
 */
export async function extractFrames(
  videoUrl: string,
  timestamps: number[],
  cssFilter?: string
): Promise<FrameSample[]> {
  const video = createVideoElement(videoUrl);
  try {
    await waitForEvent(video, "loadedmetadata");
    // Need at least HAVE_CURRENT_DATA before frames are drawable. Poll rather
    // than listen so a ready-state change between check and listener attach
    // can't strand us until the timeout.
    const readyDeadline = Date.now() + 8000;
    while (video.readyState < 2 && Date.now() < readyDeadline) {
      await sleep(50);
    }

    const canvas = document.createElement("canvas");
    // Cap extraction resolution: frames are thumbnails/judge inputs, not archival.
    const srcW = video.videoWidth || 640;
    const srcH = video.videoHeight || 360;
    const scale = Math.min(1, 640 / srcW);
    canvas.width = Math.round(srcW * scale);
    canvas.height = Math.round(srcH * scale);
    const ctx = canvas.getContext("2d");

    const duration = Number.isFinite(video.duration) ? video.duration : undefined;
    const samples: FrameSample[] = [];

    for (const timestampSec of timestamps) {
      let dataUrl: string | undefined;
      if (ctx) {
        try {
          const upperBound =
            duration !== undefined
              ? Math.max(MIN_SEEK_SEC, duration - 0.05)
              : Number.POSITIVE_INFINITY;
          const target = Math.min(Math.max(timestampSec, MIN_SEEK_SEC), upperBound);
          if (Math.abs(video.currentTime - target) > 0.001) {
            video.currentTime = target;
            await waitForEvent(video, "seeked");
          }
          ctx.filter = cssFilter ?? "none";
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        } catch {
          dataUrl = undefined; // keep the sample, just without pixels
        }
      }
      samples.push({ timestampSec, dataUrl });
    }
    return samples;
  } finally {
    releaseVideoElement(video);
  }
}
