/**
 * GET /api/media/<...path> — serve files from <repo>/data.
 *
 * - Traversal-guarded: every segment goes through runstore.safeJoin, so
 *   `..`, absolute paths, and embedded separators 404.
 * - HTTP Range support: <video> seeking requires 206 partial responses with
 *   Content-Range / Accept-Ranges; implemented via fs.createReadStream
 *   {start,end}.
 * - Caching: run.json (and any .json) is no-store — it mutates as the client
 *   syncs; media files are written once per name (gen-v1.mp4, anchor-v2.png,
 *   ...) so they get a long immutable cache.
 */

import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveMediaRequest } from "@/lib/server/runstore";

export const runtime = "nodejs";

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
    : "public, max-age=31536000, immutable";
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

/** Node read stream → web ReadableStream for the Response body. */
function streamFile(filePath: string, opts?: { start: number; end: number }): ReadableStream {
  const nodeStream = createReadStream(filePath, opts);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { path: string[] } }
): Promise<Response> {
  let filePath: string;
  try {
    filePath = resolveMediaRequest(params.path ?? []);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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

  if (range) {
    const { start, end } = range;
    return new Response(streamFile(filePath, { start, end }), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(size === 0 ? null : streamFile(filePath), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
