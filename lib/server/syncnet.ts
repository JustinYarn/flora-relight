import "server-only";

import fsp from "node:fs/promises";
import path from "node:path";
import type { SyncNetMetrics } from "@/lib/v2-sync";

function analyzeUrl(): string {
  const baseUrl = process.env.SYNCNET_BASE_URL?.trim();
  if (!baseUrl) throw new Error("SYNCNET_BASE_URL is not configured.");
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/analyze`;
}

function requireNumber(
  body: Record<string, unknown>,
  key: string
): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SyncNet returned no valid ${key} metric.`);
  }
  return value;
}

export async function analyzeVideoSync(
  videoPath: string
): Promise<SyncNetMetrics> {
  const bytes = await fsp.readFile(videoPath);
  const form = new FormData();
  form.append(
    "video_file",
    new Blob([bytes], { type: "video/mp4" }),
    path.basename(videoPath)
  );
  // Ask the service for raw metrics. Lamp owns the product decision at the
  // stable 4/10 thresholds, so the service must not reject before returning
  // both values.
  form.append("min_permitted_speech_percentage", "0");
  form.append("min_permitted_confidence", "0");
  form.append("max_permitted_distance", "1000000");
  form.append("max_permitted_absolute_offset", "1000000");

  const response = await fetch(analyzeUrl(), {
    method: "POST",
    body: form,
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`SyncNet analysis failed: ${message.slice(0, 300)}`);
  }
  if (!body || typeof body !== "object") {
    throw new Error("SyncNet returned an invalid response.");
  }
  const result = body as Record<string, unknown>;
  return {
    confidence: requireNumber(result, "confidence"),
    distance: requireNumber(result, "min_dist"),
    offsetSec: requireNumber(result, "av_offset_seconds"),
    speechPercentage: requireNumber(result, "speech_percentage"),
  };
}
