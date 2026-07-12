/**
 * lib/server/gemini.ts — server-only Gemini client + shared live helpers.
 *
 * SERVER ONLY. Reads GEMINI_API_KEY from the environment; the key is never
 * logged, never echoed into responses, and never imported into client code.
 *
 * Every live Gemini call in the app funnels through here:
 *   - lazy client singleton (one per server process)
 *   - Files API upload cache (uploads are reused across manifest, judge, and
 *     videogen calls for the same on-disk file; in-flight dedupe included)
 *   - source-url resolution ("/samples/*" and "/api/media/*" only — anything
 *     else is rejected before touching the filesystem)
 *   - data-URL / served-media image loading for inline image parts
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  isValidMediaFileName,
  isValidRunId,
  resolveMediaRequest,
} from "@/lib/server/runstore";
import { getStorage, scratchMediaPath } from "@/lib/server/storage";

// Model ids proven by the live smoke test — do not improvise alternatives.
export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
export const GEMINI_PRO_MODEL = "gemini-3.1-pro-preview";
export const OMNI_VIDEO_MODEL = "gemini-omni-flash-preview";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

let client: GoogleGenAI | null = null;

/** Lazy singleton. Throws (without key details) when the key is absent. */
export function getGemini(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini live provider is not configured on this server.");
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

/**
 * Retry thin wrapper for transient upstream failures (rate limits, 5xx).
 * Two attempts with a short backoff — enough for the judge fan-out, never
 * enough to hide a real outage.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Files API upload cache
// ---------------------------------------------------------------------------

export interface CachedUpload {
  uri: string;
  name: string;
  at: number;
}

/** Gemini keeps uploads 48h; evict our cache entries after 24h to stay safe. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_ACTIVE_TIMEOUT_MS = 180_000;
const FILE_POLL_MS = 4000;

const uploadCache = new Map<string, CachedUpload>();
const inFlightUploads = new Map<string, Promise<CachedUpload>>();

/**
 * Upload a video once per absolute path per process. Concurrent callers for
 * the same path share one upload; entries older than 24h re-upload.
 */
export async function uploadVideoCached(absPath: string): Promise<CachedUpload> {
  const now = Date.now();
  uploadCache.forEach((entry, key) => {
    if (now - entry.at > UPLOAD_TTL_MS) uploadCache.delete(key);
  });
  const hit = uploadCache.get(absPath);
  if (hit) return hit;
  const pending = inFlightUploads.get(absPath);
  if (pending) return pending;

  const job = (async (): Promise<CachedUpload> => {
    const ai = getGemini();
    let f = await ai.files.upload({ file: absPath, config: { mimeType: "video/mp4" } });
    const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;
    while (String(f.state).toUpperCase() !== "ACTIVE") {
      if (String(f.state).toUpperCase() === "FAILED") {
        throw new Error("Gemini file processing failed for the uploaded clip.");
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the uploaded clip to become ACTIVE.");
      }
      await sleep(FILE_POLL_MS);
      f = await ai.files.get({ name: f.name ?? "" });
    }
    if (!f.uri || !f.name) throw new Error("Gemini upload returned no file uri.");
    const entry: CachedUpload = { uri: f.uri, name: f.name, at: Date.now() };
    uploadCache.set(absPath, entry);
    return entry;
  })();

  inFlightUploads.set(absPath, job);
  try {
    return await job;
  } finally {
    inFlightUploads.delete(absPath);
  }
}

/** Download a Files-API uri (or name, or generated-output uri) to a local path. */
export async function downloadTo(uriOrName: string, destPath: string): Promise<void> {
  const ai = getGemini();
  await ai.files.download({ file: uriOrName, downloadPath: destPath });
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

const SAMPLES_ROOT = path.resolve(process.cwd(), "public", "samples");
const SAMPLE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Resolve a media url to an absolute LOCAL file path (ffmpeg and the Files
 * API need real files).
 *   "/samples/<name>"      → <repo>/public/samples/<name> (bundled with the
 *                            deploy — always local)
 *   "/api/media/runs/<runId>/<fileName>" → storage.getMediaToFile(): the fs
 *                            driver short-circuits to its canonical data/
 *                            path; remote drivers download into the
 *                            deterministic scratch path (once per process —
 *                            the Files-API upload cache stays keyed by it).
 *   "/api/media/<...segs>" → legacy direct read under <repo>/data (fs only)
 *   absolute https URL     → accepted only when the active driver can
 *                            reverse-map it (blob driver publicMediaUrl()
 *                            values that clients echo back as sourceUrl).
 * Anything else (blob:, foreign http:, absolute paths, ...) is rejected.
 */
export async function resolveSourceUrl(sourceUrl: string): Promise<string> {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    throw new Error("Missing source url.");
  }
  const clean = sourceUrl.split("?")[0].split("#")[0];

  if (clean.startsWith("/samples/")) {
    const name = clean.slice("/samples/".length);
    if (!SAMPLE_NAME_RE.test(name)) throw new Error("Invalid sample name.");
    const abs = path.resolve(SAMPLES_ROOT, name);
    if (!abs.startsWith(SAMPLES_ROOT + path.sep)) throw new Error("Invalid sample path.");
    await fsp.access(abs);
    return abs;
  }

  if (clean.startsWith("/api/media/")) {
    const segments = clean
      .slice("/api/media/".length)
      .split("/")
      .filter((s) => s.length > 0);
    if (
      segments.length === 3 &&
      segments[0] === "runs" &&
      isValidRunId(segments[1]) &&
      isValidMediaFileName(segments[2])
    ) {
      const [, runId, fileName] = segments;
      return getStorage().getMediaToFile(
        runId,
        fileName,
        scratchMediaPath(runId, fileName)
      );
    }
    // Legacy non-run data files — only ever local (fs driver's data dir).
    const abs = resolveMediaRequest(segments); // safeJoin under DATA_ROOT
    await fsp.access(abs);
    return abs;
  }

  if (/^https?:\/\//.test(clean)) {
    const storage = getStorage();
    const hit = storage.resolveMediaUrl ? await storage.resolveMediaUrl(sourceUrl) : null;
    if (hit) {
      return storage.getMediaToFile(
        hit.runId,
        hit.fileName,
        scratchMediaPath(hit.runId, hit.fileName)
      );
    }
  }

  throw new Error("Unsupported source url — expected /samples/* or /api/media/*.");
}

// ---------------------------------------------------------------------------
// Image loading (data URLs and served media)
// ---------------------------------------------------------------------------

export interface LoadedImage {
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
}

/** Parse a base64 data URL into { mimeType, data }. */
export function parseDataUrl(dataUrl: string): LoadedImage {
  const m = /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("Expected a base64-encoded data URL.");
  return { mimeType: m[1], data: m[2] };
}

const IMAGE_EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Load an image reference as base64: either a data URL, or a served media
 * url ("/api/media/..." — or, on the blob driver, the blob CDN URL) that we
 * resolve to a local file and read server-side (the anchor route returns
 * served urls, not data urls).
 */
export async function loadImageRef(ref: string): Promise<LoadedImage> {
  if (ref.startsWith("data:")) return parseDataUrl(ref);
  if (ref.startsWith("/api/media/") || /^https?:\/\//.test(ref)) {
    const abs = await resolveSourceUrl(ref);
    const mimeType = IMAGE_EXT_MIME[path.extname(abs).toLowerCase()];
    if (!mimeType) throw new Error("Unsupported image type for reference image.");
    const buf = await fsp.readFile(abs);
    return { mimeType, data: buf.toString("base64") };
  }
  throw new Error("Unsupported image reference — expected a data URL or /api/media/*.");
}
