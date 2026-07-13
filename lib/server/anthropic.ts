/**
 * lib/server/anthropic.ts — server-only Anthropic client.
 *
 * SERVER ONLY. Reads ANTHROPIC_API_KEY from the environment; the key is never
 * logged, never echoed into responses, and never imported into client code.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Judge model — structured output via output_config.format (json_schema).
 * claude-fable-5: Anthropic's most capable model ($10/$50 per MTok, ~2x Opus).
 * Thinking is always on (never send a `thinking` param); safety classifiers
 * can return stop_reason "refusal", so judge calls ride with a server-side
 * fallback to Opus 4.8 (the recommended default for Fable 5 code).
 */
export const CLAUDE_JUDGE_MODEL = "claude-fable-5";
export const CLAUDE_FALLBACK_MODEL = "claude-opus-4-8";
export const CLAUDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";

export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;

/** Lazy singleton. Throws (without key details) when the key is absent. */
export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic live provider is not configured on this server.");
  if (!client) client = new Anthropic({ apiKey });
  return client;
}
