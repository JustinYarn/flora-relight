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
 * The cookie derivation + verification live in lib/server/gate.ts (Web
 * Crypto, Edge-compatible) so the middleware, the gate route, and the blob
 * upload token route all share one implementation: a static
 * hex(SHA-256(salt:password)) token, deliberately simple (single shared
 * password, no sessions/users). Rotating the password invalidates every
 * cookie. Comparison is constant-time.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyGateCookie } from "@/lib/server/gate";

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const password = process.env.FLORA_ACCESS_PASSWORD;
  if (!password) return NextResponse.next(); // gate disabled — no-op

  const { pathname } = req.nextUrl;
  // The gate itself must stay reachable or nobody can ever log in.
  if (pathname === "/gate" || pathname === "/api/gate") return NextResponse.next();

  if (await verifyGateCookie(req)) {
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
