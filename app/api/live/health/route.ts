/**
 * GET /api/live/health — is live mode available?
 *
 * Reports only booleans; never echoes key material or env details. The
 * client store's hydrate() flips mode to "live" when the production first-cut
 * path is available. The optional full-evaluation capability is reported
 * separately because durable live execution currently stops at human review.
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
    live: gemini,
    capabilities: {
      firstCut: gemini,
      automatedEvaluation: gemini && anthropic,
    },
    providers: { gemini, anthropic },
  });
}
