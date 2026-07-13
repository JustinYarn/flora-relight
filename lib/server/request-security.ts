/**
 * Browser request checks shared by Edge middleware and Node route handlers.
 *
 * A valid gate cookie proves that the browser previously knew the shared
 * password; it does not prove that an unsafe request came from this origin.
 * Exact-origin / Fetch Metadata checks close that CSRF gap, including hostile
 * sibling subdomains that browsers classify as "same-site".
 *
 * Keep this module Edge-compatible: middleware imports it.
 */

import type { NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SameOriginCheck {
  ok: boolean;
  reason?: "invalid_origin" | "missing_browser_proof" | "cross_origin_fetch";
}

/**
 * Require exact same-origin proof for state-changing browser requests.
 *
 * `Origin` is preferred. Fetch Metadata is an acceptable fallback because
 * `Sec-Fetch-Site` is a forbidden browser header and cannot be forged by
 * cross-origin page JavaScript. Requests with neither signal fail closed.
 */
export function checkSameOriginRequest(req: NextRequest): SameOriginCheck {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return { ok: true };

  const expectedOrigin = req.nextUrl.origin;
  const originHeader = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();

  if (originHeader) {
    let origin: string;
    try {
      origin = new URL(originHeader).origin;
    } catch {
      return { ok: false, reason: "invalid_origin" };
    }
    if (origin !== expectedOrigin) {
      return { ok: false, reason: "invalid_origin" };
    }
  } else if (fetchSite !== "same-origin") {
    return { ok: false, reason: "missing_browser_proof" };
  }

  // Reject contradictory metadata even when Origin itself looks valid.
  if (fetchSite && fetchSite !== "same-origin") {
    return { ok: false, reason: "cross_origin_fetch" };
  }

  return { ok: true };
}
