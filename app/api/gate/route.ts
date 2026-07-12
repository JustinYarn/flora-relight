/**
 * POST /api/gate — exchange the access password for the gate cookie.
 *
 * Form body: { password, from? }. Constant-time comparison (both sides are
 * SHA-256 hashed first so timingSafeEqual always gets equal-length buffers
 * and the check leaks neither content nor length). Success sets the
 * httpOnly cookie the middleware checks and 303-redirects to `from`
 * (relative paths only); failure bounces back to /gate?error=1.
 *
 * Token derivation lives in lib/server/gate.ts (shared with middleware.ts
 * and the blob upload token route): hex(SHA-256("<salt>:<password>")).
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { GATE_COOKIE, expectedGateToken } from "@/lib/server/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

function passwordsMatch(submitted: string, actual: string): boolean {
  const a = createHash("sha256").update(submitted).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

/** Only same-site relative paths make valid redirect targets. */
function safeFrom(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
    ? raw
    : "/";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const password = process.env.FLORA_ACCESS_PASSWORD;
  if (!password) {
    // Gate disabled — nothing to authenticate against.
    return NextResponse.redirect(new URL("/", req.url), 303);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.redirect(new URL("/gate?error=1", req.url), 303);
  }
  const submitted = form.get("password");
  const from = safeFrom(form.get("from"));

  if (typeof submitted !== "string" || !passwordsMatch(submitted, password)) {
    const url = new URL("/gate", req.url);
    url.searchParams.set("error", "1");
    url.searchParams.set("from", from);
    return NextResponse.redirect(url, 303);
  }

  const res = NextResponse.redirect(new URL(from, req.url), 303);
  res.cookies.set(GATE_COOKIE, await expectedGateToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
  return res;
}
