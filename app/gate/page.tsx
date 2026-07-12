/**
 * /gate — minimal password form for the deployment access gate.
 *
 * Rendered when middleware.ts (FLORA_ACCESS_PASSWORD set) redirects an
 * unauthenticated page request here. Plain HTML form POST to /api/gate — no
 * client JS, no new deps. Local dev without the env var never sees this page.
 */

export const dynamic = "force-dynamic";

interface GateSearchParams {
  from?: string;
  error?: string;
}

export default function GatePage({
  searchParams,
}: {
  searchParams?: GateSearchParams;
}) {
  const rawFrom = searchParams?.from;
  const from =
    typeof rawFrom === "string" && rawFrom.startsWith("/") && !rawFrom.startsWith("//")
      ? rawFrom
      : "/";
  const failed = searchParams?.error === "1";

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <form
        method="POST"
        action="/api/gate"
        className="w-full max-w-sm space-y-4 rounded-xl border border-edge bg-surface p-8"
      >
        <div>
          <h1 className="text-sm font-semibold text-ink">
            <span className="text-accent">✦</span> Access required
          </h1>
          <p className="mt-1 text-xs text-faint">
            This deployment is password-protected. Enter the access password to
            continue.
          </p>
        </div>
        {failed ? (
          <p className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-400">
            Wrong password — try again.
          </p>
        ) : null}
        <input type="hidden" name="from" value={from} />
        <input
          type="password"
          name="password"
          required
          autoFocus
          autoComplete="current-password"
          placeholder="Access password"
          className="w-full rounded-md border border-edge bg-transparent px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        <button
          type="submit"
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Enter
        </button>
      </form>
    </div>
  );
}
