/**
 * GET /api/live/health — is live mode available?
 *
 * Reports only booleans; never echoes key material or env details. The
 * client store's hydrate() flips mode to "live" when `live` is true.
 */

import { NextResponse } from "next/server";
import { hasGeminiKey } from "@/lib/server/gemini";
import { hasAnthropicKey } from "@/lib/server/anthropic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const gemini = hasGeminiKey();
  const anthropic = hasAnthropicKey();
  return NextResponse.json({
    live: gemini && anthropic,
    providers: { gemini, anthropic },
  });
}
