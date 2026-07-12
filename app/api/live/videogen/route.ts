/**
 * POST /api/live/videogen — Omni Flash video-to-video relight (proven shape #3).
 *
 * Body: { runId, iteration, prompt, sourceUrl, previousInteractionId? }
 *
 * Flow: resolve source → (first call per run) copy into
 * data/runs/<runId>/source.mp4 + demux source-audio.m4a → guard ≤10.05s →
 * upload (cached) → interactions.create (blocks ~1-7 min and returns the
 * COMPLETED interaction — no polling) → download gen-v<N>.mp4 → remux the
 * ORIGINAL audio (the model's own audio is discarded by construction) →
 * verify the audio stream md5 bit-for-bit over the shared duration.
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "node:fs/promises";
import {
  OMNI_VIDEO_MODEL,
  downloadTo,
  getGemini,
  resolveSourceUrl,
  uploadVideoCached,
} from "@/lib/server/gemini";
import {
  audioStreamMd5,
  demuxAudio,
  probe,
  remuxAudio,
} from "@/lib/server/ffmpeg";
import { isValidRunId } from "@/lib/server/runstore";
import { getStorage, scratchMediaPath } from "@/lib/server/storage";
import { PRICE_TABLE } from "@/lib/cost";

export const runtime = "nodejs";
// Omni generations block 1-7 min; vercel.json raises this to 800s for the
// deployed function (requires the Pro plan — Hobby caps at 300).
export const maxDuration = 300;

/** Omni Flash input cap, with a whisker of probe/rounding tolerance. */
const MAX_INPUT_SECONDS = 10.05;

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

interface VideogenBody {
  runId?: unknown;
  iteration?: unknown;
  prompt?: unknown;
  sourceUrl?: unknown;
  previousInteractionId?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: VideogenBody;
  try {
    body = (await req.json()) as VideogenBody;
  } catch {
    return jsonError(400, "Expected a JSON body.");
  }

  const { runId, iteration, prompt, sourceUrl, previousInteractionId } = body;
  if (!isValidRunId(runId)) return jsonError(400, "Invalid runId.");
  if (typeof iteration !== "number" || !Number.isInteger(iteration) || iteration < 1) {
    return jsonError(400, "iteration must be a positive integer.");
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    return jsonError(400, "Missing prompt.");
  }
  if (typeof sourceUrl !== "string") return jsonError(400, "Missing sourceUrl.");
  if (previousInteractionId !== undefined && typeof previousInteractionId !== "string") {
    return jsonError(400, "previousInteractionId must be a string.");
  }

  let resolvedSource: string;
  try {
    resolvedSource = await resolveSourceUrl(sourceUrl);
  } catch {
    return jsonError(400, "Unresolvable source url.");
  }

  const storage = getStorage();

  try {
    // --- pin the source (and its audio) into this run's media --------------
    // fs driver: local paths below are the canonical data/ files and the
    // putMediaFromFile calls are no-ops — byte-identical pre-seam behavior.
    // Remote drivers: everything round-trips through the scratch dir because
    // ffmpeg and the Files API need real local files.
    let src: string;
    if (await storage.mediaExists(runId, "source.mp4")) {
      src = await storage.getMediaToFile(
        runId,
        "source.mp4",
        scratchMediaPath(runId, "source.mp4")
      );
    } else {
      const dest = await storage.mediaWritePath(runId, "source.mp4");
      if (resolvedSource === dest) return jsonError(400, "Source file missing.");
      await fsp.copyFile(resolvedSource, dest);
      await storage.putMediaFromFile(runId, "source.mp4", dest);
      src = dest;
    }

    const srcProbe = await probe(src);
    if (srcProbe.durationSec > MAX_INPUT_SECONDS) {
      return jsonError(
        422,
        `Source is ${srcProbe.durationSec.toFixed(2)}s — Omni Flash accepts at most 10s. Re-ingest to trim.`
      );
    }

    const hasAudio = srcProbe.hasAudio;
    let audioPath: string | null = null;
    if (hasAudio) {
      if (await storage.mediaExists(runId, "source-audio.m4a")) {
        audioPath = await storage.getMediaToFile(
          runId,
          "source-audio.m4a",
          scratchMediaPath(runId, "source-audio.m4a")
        );
      } else {
        audioPath = await storage.mediaWritePath(runId, "source-audio.m4a");
        await demuxAudio(src, audioPath);
        await storage.putMediaFromFile(runId, "source-audio.m4a", audioPath);
      }
    }

    // --- generate (proven call shape; blocks until completed) --------------
    const upload = await uploadVideoCached(src);
    const ai = getGemini();
    const gen = await ai.interactions.create({
      model: OMNI_VIDEO_MODEL,
      input: [
        { type: "text", text: prompt },
        { type: "video", uri: upload.uri, mime_type: "video/mp4" },
      ],
      response_format: { type: "video", delivery: "uri" },
      ...(previousInteractionId
        ? { previous_interaction_id: previousInteractionId }
        : {}),
    });

    const outUri = gen.output_video?.uri;
    if (!outUri || !gen.id) {
      return jsonError(502, "Video generation returned no output video.");
    }

    // --- download + remux the ORIGINAL audio (model audio discarded) --------
    const genName = `gen-v${iteration}.mp4`;
    const genPath = await storage.mediaWritePath(runId, genName);
    await downloadTo(outUri, genPath);
    await storage.putMediaFromFile(runId, genName, genPath);

    const relitName = `relit-v${iteration}.mp4`;
    const relitPath = await storage.mediaWritePath(runId, relitName);
    let audioVerified = false;
    if (hasAudio && audioPath) {
      await remuxAudio(genPath, audioPath, relitPath);
      const [relitProbe, audioProbe] = await Promise.all([
        probe(relitPath),
        probe(audioPath),
      ]);
      const minDur = Math.min(relitProbe.durationSec, audioProbe.durationSec);
      try {
        const [a, b] = await Promise.all([
          audioStreamMd5(audioPath, minDur),
          audioStreamMd5(relitPath, minDur),
        ]);
        audioVerified = a.length > 0 && a === b;
      } catch {
        audioVerified = false; // verification failure is a red gate, not a crash
      }
    } else {
      // No source audio: nothing to preserve — ship the generation as-is
      // (its own audio already absent or irrelevant; nothing was lost).
      await fsp.copyFile(genPath, relitPath);
      audioVerified = true;
    }
    await storage.putMediaFromFile(runId, relitName, relitPath);

    const finalProbe = await probe(relitPath);
    const durationSec = finalProbe.durationSec;

    return NextResponse.json({
      videoUrl: await storage.publicMediaUrl(runId, relitName),
      rawUrl: await storage.publicMediaUrl(runId, genName),
      interactionId: gen.id,
      durationSec,
      audioVerified,
      costUsd: durationSec * PRICE_TABLE.omniFlashPerOutputSecond.usd,
    });
  } catch (err) {
    console.error("[live/videogen] failed:", err instanceof Error ? err.message : err);
    return jsonError(502, "Video generation failed upstream.");
  }
}
