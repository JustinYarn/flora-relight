/**
 * Config-only preflight for Lamp's V2 sync stack. Deliberately NOT marked
 * server-only: it never touches secret values (names and shapes only), and
 * the admission routes, readiness probe, and tests all need it.
 *
 * The quote checks exist because `vercel env add` stores surrounding quotes
 * literally (observed live 2026-07-15) — a mangled value must surface at
 * admission, before the first billed generation, not after ~$4 of spend at
 * the V2 finalization step.
 */
export function v2SyncConfigIssue(): string | null {
  const base = process.env.SYNCNET_BASE_URL?.trim();
  if (!base) return "SYNCNET_BASE_URL is not configured.";
  if (/^['"]|['"]$/.test(base)) {
    return "SYNCNET_BASE_URL contains surrounding quotes (stored literally).";
  }
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "SYNCNET_BASE_URL must be an http(s) URL.";
    }
  } catch {
    return "SYNCNET_BASE_URL is not a valid URL.";
  }
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (!token) return "REPLICATE_API_TOKEN is not configured.";
  if (/^['"]|['"]$/.test(token)) {
    return "REPLICATE_API_TOKEN contains surrounding quotes (stored literally).";
  }
  return null;
}
