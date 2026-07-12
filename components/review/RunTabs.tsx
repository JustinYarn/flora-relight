import Link from "next/link";

/**
 * Pinned two-tab segmented control shared by the Review and Journey pages.
 * Contract (do not restyle): rounded-lg border border-edge p-0.5 wrapper,
 * two Links px-3 py-1 text-sm, active = bg-raised text-ink, inactive = text-muted.
 */
export function RunTabs({
  runId,
  active,
}: {
  runId: string;
  active: "review" | "journey";
}) {
  const linkClass = (tab: "review" | "journey") =>
    `rounded-md px-3 py-1 text-sm transition ${
      active === tab ? "bg-raised text-ink" : "text-muted hover:text-ink"
    }`;
  return (
    <nav className="flex items-center rounded-lg border border-edge p-0.5">
      <Link href={`/runs/${runId}`} className={linkClass("review")}>
        Review
      </Link>
      <Link href={`/runs/${runId}/journey`} className={linkClass("journey")}>
        Journey
      </Link>
    </nav>
  );
}
