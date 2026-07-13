/**
 * Diagnostic: reports how ffmpeg discovery sees the deployed environment.
 * Disabled by default because the detailed report includes process paths and
 * low-level execution errors. Enable only briefly with
 * FLORA_FFMPEG_DEBUG_ENABLED=1 on a password-protected deployment.
 */

import { NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { probe } from "@/lib/server/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function enabled(): boolean {
  return process.env.FLORA_FFMPEG_DEBUG_ENABLED === "1";
}

function tryRun(bin: string): string {
  try {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 10000 });
    if (r.error) return `spawn error: ${r.error.message}`;
    if (r.status !== 0) return `exit ${r.status}: ${(r.stderr || "").slice(0, 120)}`;
    return `OK: ${(r.stdout || "").split("\n")[0].slice(0, 80)}`;
  } catch (e) {
    return `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function GET(): Promise<NextResponse> {
  if (!enabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let requirePath: string | null = null;
  let requireError: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    requirePath = require("ffmpeg-static") as string | null;
  } catch (e) {
    requireError = e instanceof Error ? e.message : String(e);
  }

  const candidates = ["ffmpeg", "/usr/bin/ffmpeg", requirePath].filter(
    (c): c is string => Boolean(c)
  );
  const report: Record<string, unknown> = {
    platform: process.platform,
    cwd: process.cwd(),
    requirePath,
    requireError,
    requirePathExists: requirePath ? existsSync(requirePath) : null,
    requirePathMode:
      requirePath && existsSync(requirePath)
        ? (statSync(requirePath).mode & 0o777).toString(8)
        : null,
    runs: Object.fromEntries(candidates.map((c) => [c, tryRun(c)])),
  };

  try {
    // Exercises the real discovery + /tmp-copy fallback end to end.
    await probe("/nonexistent-file.mp4");
    report.discovery = "unexpected success";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report.discovery = msg.includes("ffmpeg not found")
      ? `DISCOVERY FAILED: ${msg}`
      : `discovery OK (probe failed on the fake file as expected: ${msg.slice(0, 100)})`;
  }

  return NextResponse.json(report, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
