/**
 * GET /api/media/<...path> — serve run media through the storage driver.
 *
 * Canonical shape: /api/media/runs/<runId>/<fileName>.
 *   - fs driver: streamed from <repo>/data with HTTP Range support (206 +
 *     Content-Range / Accept-Ranges — <video> seeking needs it), exactly the
 *     pre-seam behavior.
 *   - blob driver: gate-authenticated proxy through @vercel/blob get(). The
 *     provider URL and read token never reach the browser; single Range
 *     requests are forwarded so <video> seeking still works.
 *
 * Any other path (legacy: arbitrary files under <repo>/data) is served
 * directly from disk on the fs driver only; the blob driver stores nothing
 * outside runs/<runId>/, so those 404.
 *
 * - Traversal-guarded: every segment goes through runstore.safeJoin, so
 *   `..`, absolute paths, and embedded separators 404.
 * - Caching: run.json (and any .json) is no-store — it mutates as the client
 *   syncs; media files are written once per name (gen-v1.mp4, anchor-v2.png,
 *   ...) so they get a long immutable cache.
 */

import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  isValidMediaFileName,
  isValidRunId,
  resolveMediaRequest,
} from "@/lib/server/runstore";
import {
  hostedGateConfigurationIssue,
  verifyGateCookie,
} from "@/lib/server/gate";
import { getStorage } from "@/lib/server/storage";

export const runtime = "nodejs";

// Server-side idempotency marker. It contains internal upload identity and is
// never a browser media asset, even on the local filesystem driver.
const INTERNAL_INGEST_RECEIPT = "ingest-result.json";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function cacheControlFor(filePath: string): string {
  // JSON (run.json etc.) mutates in place — never cache. Media files are
  // write-once per filename — cache hard.
  return path.extname(filePath).toLowerCase() === ".json"
    ? "no-store"
    : "private, no-cache";
}

/**
 * Parse a Range header against a file of `size` bytes.
 * Returns null when there is no (usable single) range; "unsatisfiable" when
 * the range is syntactically valid but outside the file.
 */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or malformed — serve the whole file (200)
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/**
 * Serve a run media file through the storage driver with Range support. Both
 * drivers return bytes; the Blob driver performs its authenticated provider
 * read behind this same-origin route.
 */
async function serveRunMedia(
  req: NextRequest,
  runId: string,
  fileName: string
): Promise<Response> {
  const storage = getStorage();

  const stat = await storage.statMedia(runId, fileName);
  if (!stat) return notFound();

  const size = stat.size;
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentTypeFor(fileName),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControlFor(fileName),
    "Last-Modified": new Date(stat.mtimeMs).toUTCString(),
  };

  const range = parseRange(req.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  if (range) {
    const { start, end } = range;
    return new Response(await storage.mediaReadStream(runId, fileName, { start, end }), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(size === 0 ? null : await storage.mediaReadStream(runId, fileName), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

/** Legacy fallback: arbitrary (guarded) files under <repo>/data — fs only. */
async function serveDataFile(req: NextRequest, segments: string[]): Promise<Response> {
  let filePath: string;
  try {
    filePath = resolveMediaRequest(segments);
  } catch {
    return notFound();
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();

  const size = stat.size;
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentTypeFor(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControlFor(filePath),
    "Last-Modified": stat.mtime.toUTCString(),
  };

  const range = parseRange(req.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  const streamFile = (opts?: { start: number; end: number }): ReadableStream =>
    Readable.toWeb(createReadStream(filePath, opts)) as unknown as ReadableStream;

  if (range) {
    const { start, end } = range;
    return new Response(streamFile({ start, end }), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(size === 0 ? null : streamFile(), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  // Defense in depth: do not rely solely on middleware continuing to include
  // this sensitive route. Hosted deployments also fail closed when the gate
  // password itself is absent.
  if (hostedGateConfigurationIssue(process.env.FLORA_ACCESS_PASSWORD)) {
    return NextResponse.json(
      { error: "Production access protection is not configured." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  if (!(await verifyGateCookie(req))) {
    return NextResponse.json(
      { error: "Access gate: authentication required." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const segments = (await params).path ?? [];

  if (segments.at(-1) === INTERNAL_INGEST_RECEIPT) return notFound();

  if (
    segments.length === 3 &&
    segments[0] === "runs" &&
    isValidRunId(segments[1]) &&
    isValidMediaFileName(segments[2])
  ) {
    return serveRunMedia(req, segments[1], segments[2]);
  }

  // Non-canonical path: only meaningful on the fs driver's local data dir.
  if (getStorage().name !== "fs") return notFound();
  return serveDataFile(req, segments);
}
