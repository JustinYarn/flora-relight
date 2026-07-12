/**
 * middleware.ts — optional password gate for deployed instances.
 *
 * When FLORA_ACCESS_PASSWORD is set, EVERY page and API route (including
 * /api/media) requires the httpOnly gate cookie issued by POST /api/gate
 * (see app/gate/page.tsx + app/api/gate/route.ts). Requests without it:
 * pages redirect to /gate, API calls get 401 JSON.
 *
 * Env absent → complete no-op, local dev unchanged.
 *
 * The cookie value is hex(SHA-256(salt:password)) — a static shared token,
 * deliberately simple (single shared password, no sessions/users). Rotating
 * the password invalidates every cookie. Comparison is constant-time.
 * Middleware runs on the Edge runtime, so hashing uses Web Crypto here and
 * node:crypto in the route handler — same derivation, byte-identical tokens.
 */

import { NextRequest, NextResponse } from "next/server";

const GATE_COOKIE = "flora_gate";
const TOKEN_SALT = "flora-relight-gate-v1";

let cached: { password: string; token: string } | null = null;

/** hex(SHA-256("<salt>:<password>")) — memoized per process. */
async function expectedToken(password: string): Promise<string> {
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
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const password = process.env.FLORA_ACCESS_PASSWORD;
  if (!password) return NextResponse.next(); // gate disabled — no-op

  const { pathname } = req.nextUrl;
  // The gate itself must stay reachable or nobody can ever log in.
  if (pathname === "/gate" || pathname === "/api/gate") return NextResponse.next();

  const cookie = req.cookies.get(GATE_COOKIE)?.value;
  if (cookie && timingSafeEqualStr(cookie, await expectedToken(password))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Access gate: authentication required." },
      { status: 401 }
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  url.search = "";
  url.searchParams.set("from", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Gate everything except Next's static assets (the gate page needs its own
  // CSS/JS chunks to render) and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
