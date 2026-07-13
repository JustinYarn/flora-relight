import "server-only";

import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractJpegFrame, probe } from "@/lib/server/ffmpeg";
import { resolveSourceUrl } from "@/lib/server/gemini";

export interface ServerFrameSample {
  timestampSec: number;
  dataUrl: string;
  sha256: string;
}

/**
 * Extract canonical judge pixels server-side. Browser-provided data URLs are
 * deliberately not an input: the media URL has already been bound to a Run's
 * server-owned source/provider journal before this helper is called.
 */
export async function extractServerFrames(
  videoUrl: string,
  timestamps: number[],
  width = 640
): Promise<ServerFrameSample[]> {
  if (timestamps.length === 0 || timestamps.length > 12) {
    throw new Error("Frame extraction requires between 1 and 12 timestamps.");
  }
  const sourcePath = await resolveSourceUrl(videoUrl);
  const source = await probe(sourcePath);
  if (!Number.isFinite(source.durationSec) || source.durationSec <= 0) {
    throw new Error("Frame extraction requires a video with a positive duration.");
  }
  const nonce = randomBytes(8).toString("hex");
  const outputs: string[] = [];
  try {
    const frames: ServerFrameSample[] = [];
    for (let index = 0; index < timestamps.length; index += 1) {
      const requestedTimestampSec = timestamps[index];
      if (!Number.isFinite(requestedTimestampSec) || requestedTimestampSec < 0) {
        throw new Error("Frame timestamps must be finite non-negative numbers.");
      }
      // The canonical schedule targets a ten-second clip, but uploads may be
      // shorter. Seek to the closest real frame instead of failing the whole
      // judge grid because (for example) t=9.5s is past a three-second source.
      const timestampSec = Math.min(
        requestedTimestampSec,
        Math.max(0, source.durationSec - 0.05)
      );
      const outputPath = path.join(
        os.tmpdir(),
        `flora-frame-${nonce}-${index}.jpg`
      );
      outputs.push(outputPath);
      await extractJpegFrame(sourcePath, timestampSec, outputPath, width);
      const bytes = await fsp.readFile(outputPath);
      frames.push({
        timestampSec,
        dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return frames;
  } finally {
    await Promise.all(outputs.map((output) => fsp.rm(output, { force: true })));
  }
}
