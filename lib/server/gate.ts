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
const TOKEN_SALT = "flora-relight-gate-v1";

let cached: { password: string; token: string } | null = null;

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
 * May this request pass the gate? True when FLORA_ACCESS_PASSWORD is unset
 * (gate disabled — matches the middleware no-op) or when the request carries
 * a valid gate cookie.
 */
export async function verifyGateCookie(req: NextRequest): Promise<boolean> {
  const password = process.env.FLORA_ACCESS_PASSWORD;
  if (!password) return true;
  const cookie = req.cookies.get(GATE_COOKIE)?.value;
  return Boolean(cookie && timingSafeEqualStr(cookie, await expectedGateToken(password)));
}
