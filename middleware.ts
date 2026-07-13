/**
 * middleware.ts — optional password gate for deployed instances.
 *
 * When FLORA_ACCESS_PASSWORD is set, EVERY page and API route (including
 * /api/media) requires the httpOnly gate cookie issued by POST /api/gate
 * (see app/gate/page.tsx + app/api/gate/route.ts). Requests without it:
 * pages redirect to /gate, API calls get 401 JSON.
 *
 * Env absent → local development remains open; hosted/production fails
 * closed so a missing password cannot expose upload or paid-provider routes.
 *
 * The cookie derivation + verification live in lib/server/gate.ts (Web
 * Crypto, Edge-compatible) so the middleware, the gate route, and the blob
 * upload token route all share one implementation: a static
 * hex(SHA-256(salt:password)) token, deliberately simple (single shared
 * password, no sessions/users). Rotating the password invalidates every
 * cookie. Comparison is constant-time.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  hostedGateConfigurationIssue,
  verifyGateCookie,
} from "@/lib/server/gate";
import { checkSameOriginRequest } from "@/lib/server/request-security";

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  // Workflow's generated control plane must never be redirected through the
  // human password gate; the platform authenticates these internal requests.
  if (pathname.startsWith("/.well-known/workflow/")) return NextResponse.next();

  // Vercel Blob completion callbacks are server-to-server and carry a signed
  // x-vercel-signature instead of browser Origin / Fetch Metadata headers.
  // The token route verifies that signature before accepting the callback.
  if (
    pathname === "/api/ingest/token" &&
    req.headers.has("x-vercel-signature")
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const sameOrigin = checkSameOriginRequest(req);
    if (!sameOrigin.ok) {
      return NextResponse.json(
        { error: "Cross-origin request rejected." },
        {
          status: 403,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        }
      );
    }
  }

  const password = process.env.FLORA_ACCESS_PASSWORD;
  const gateConfigurationIssue = hostedGateConfigurationIssue(password);
  if (gateConfigurationIssue) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Production access protection is not configured securely." },
        {
          status: 503,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        }
      );
    }
    return new NextResponse(
      "This deployment is unavailable until access protection is configured securely.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store, max-age=0",
        },
      }
    );
  }
  if (!password) {
    return NextResponse.next();
  }

  // The gate itself must stay reachable or nobody can ever log in.
  if (pathname === "/gate") return NextResponse.next();

  // The login endpoint stays unauthenticated, but its POST still passed the
  // same-origin check above.
  if (pathname === "/api/gate") return NextResponse.next();

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
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)"],
};
