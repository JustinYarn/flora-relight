/**
 * lib/server/gate.ts — shared verification for the FLORA_ACCESS_PASSWORD
 * gate cookie.
 *
 * Used by middleware.ts (Edge runtime), the gate route (cookie issuance), and
 * the blob client-upload token route (app/api/ingest/token) — that route
 * mints write access to the blob store, so it re-checks the cookie itself
 * instead of trusting the middleware matcher to keep covering it.
 *
 * Everything here must stay EDGE-COMPATIBLE: Web Crypto only, no node:*
 * imports. Node route handlers share the same globals (Node >= 20), so the
 * derivation is byte-identical in both runtimes.
 *
 * The cookie value is hex(SHA-256("<salt>:<password>")) — a static shared
 * token, deliberately simple (single shared password, no sessions/users).
 * Rotating the password invalidates every cookie. Comparison is
 * constant-time.
 */

import type { NextRequest } from "next/server";

export const GATE_COOKIE = "flora_gate";
export const MIN_HOSTED_GATE_PASSWORD_LENGTH = 20;
const TOKEN_SALT = "flora-relight-gate-v1";

let cached: { password: string; token: string } | null = null;

export type HostedGateConfigurationIssue =
  | "missing"
  | "too_short"
  | "surrounding_whitespace";

/** Hosted/production environments must never run with a weak shared gate. */
export function hostedGateConfigurationIssue(
  password: string | undefined
): HostedGateConfigurationIssue | null {
  const hosted =
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.VERCEL_ENV === "production";
  if (!hosted) return null;
  if (!password) return "missing";
  if (password.trim() !== password) return "surrounding_whitespace";
  if (password.length < MIN_HOSTED_GATE_PASSWORD_LENGTH) return "too_short";
  return null;
}

/** Normalize an untrusted post-login target to a same-origin path. */
export function safeGateRedirect(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length > 2_048 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(raw) ||
    /^\/(?:%2f|%5c)/i.test(raw)
  ) {
    return "/";
  }

  try {
    const base = new URL("https://flora-gate.invalid/");
    const target = new URL(raw, base);
    if (target.origin !== base.origin) return "/";
    return `${target.pathname}${target.search}`;
  } catch {
    return "/";
  }
}

/** hex(SHA-256("<salt>:<password>")) — memoized per process. */
export async function expectedGateToken(password: string): Promise<string> {
  if (cached?.password === password) return cached.token;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${TOKEN_SALT}:${password}`)
  );
  const token = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  cached = { password, token };
  return token;
}

/** Constant-time string comparison (no early exit on first mismatch). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * May this request pass the gate? True when FLORA_ACCESS_PASSWORD is unset in
 * local development, or when the request carries a valid gate cookie. Hosted
 * missing/weak configuration fails closed even if middleware is bypassed.
 */
export async function verifyGateCookie(req: NextRequest): Promise<boolean> {
  const password = process.env.FLORA_ACCESS_PASSWORD;
  if (hostedGateConfigurationIssue(password)) return false;
  if (!password) return true;
  const cookie = req.cookies.get(GATE_COOKIE)?.value;
  return Boolean(cookie && timingSafeEqualStr(cookie, await expectedGateToken(password)));
}
