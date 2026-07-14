import Link from "next/link";

/**
 * Pinned two-tab segmented control shared by the Review and Journey pages.
 * Contract (do not restyle): rounded-lg border border-edge p-0.5 wrapper,
 * two Links px-3 py-1 text-sm, active = bg-raised text-ink, inactive = text-muted.
 */
export function RunTabs({
  runId,
  active,
  journeyLocked = false,
}: {
  runId: string;
  active: "review" | "journey";
  journeyLocked?: boolean;
}) {
  const linkClass = (tab: "review" | "journey") =>
    `inline-flex min-h-10 items-center rounded-md px-3 py-1 text-sm transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] ${
      active === tab ? "bg-raised text-ink" : "text-muted hover:text-ink"
    }`;
  return (
    <nav className="flex items-center rounded-lg border border-edge p-0.5">
      <Link href={`/runs/${runId}`} className={linkClass("review")}>
        Review
      </Link>
      {journeyLocked ? (
        <span
          className="inline-flex min-h-10 cursor-not-allowed items-center rounded-md px-3 py-1 text-sm text-faint"
          title="Journey unlocks after the blind human grade is saved"
        >
          Journey
        </span>
      ) : (
        <Link href={`/runs/${runId}/journey`} className={linkClass("journey")}>
          Journey
        </Link>
      )}
    </nav>
  );
}
