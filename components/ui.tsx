import type { ReactNode } from "react";
import type { NodeRunStatus, Verdict } from "@/lib/types";

/* Shared primitives. All pages/components build from these so the tool reads
   as one surface. Colors come from the CSS variables in globals.css. */

export function verdictColor(v: Verdict): string {
  return v === "pass"
    ? "var(--pass)"
    : v === "borderline"
      ? "var(--borderline)"
      : "var(--fail)";
}

export function statusColor(s: NodeRunStatus): string {
  switch (s) {
    case "running":
      return "var(--running)";
    case "succeeded":
      return "var(--pass)";
    case "failed":
      return "var(--fail)";
    case "queued":
      return "var(--borderline)";
    default:
      return "var(--faint)";
  }
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-edge bg-surface ${className}`}>
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
        {children}
      </h2>
      {right}
    </div>
  );
}

export function Badge({
  children,
  color = "var(--muted)",
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <Badge color={verdictColor(verdict)}>{verdict}</Badge>;
}

export function StatusDot({ status }: { status: NodeRunStatus }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${status === "running" ? "node-running" : ""}`}
      style={{ background: statusColor(status) }}
    />
  );
}

/** 0–100 score bar, colored by verdict. */
export function ScoreMeter({
  score,
  verdict,
}: {
  score: number;
  verdict: Verdict;
}) {
  const color = verdictColor(verdict);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${score}%`, background: color }}
        />
      </div>
      <span
        className="w-8 text-right text-xs font-semibold tabular-nums"
        style={{ color }}
      >
        {Math.round(score)}
      </span>
    </div>
  );
}

/** 0–1 confidence as five segments — reads as "how much to trust the score". */
export function ConfidenceMeter({ confidence }: { confidence: number }) {
  const filled = Math.round(confidence * 5);
  return (
    <div
      className="flex items-center gap-1"
      title={`Judge agreement: ${Math.round(confidence * 100)}%`}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className="h-2.5 w-1 rounded-sm"
          style={{
            background:
              i < filled
                ? confidence >= 0.7
                  ? "var(--pass)"
                  : confidence >= 0.4
                    ? "var(--borderline)"
                    : "var(--fail)"
                : "var(--raised)",
          }}
        />
      ))}
      <span className="ml-1 text-2xs tabular-nums text-faint">
        {Math.round(confidence * 100)}%
      </span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "success" | "danger";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-accent text-[#0b0d10] hover:brightness-110 border border-transparent font-semibold",
    ghost: "bg-transparent text-muted hover:text-ink border border-edge hover:border-faint",
    success:
      "bg-[color-mix(in_srgb,var(--pass)_16%,transparent)] text-pass border border-[color-mix(in_srgb,var(--pass)_40%,transparent)] hover:brightness-110",
    danger:
      "bg-[color-mix(in_srgb,var(--fail)_14%,transparent)] text-fail border border-[color-mix(in_srgb,var(--fail)_40%,transparent)] hover:brightness-110",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg px-3.5 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-faint">{k}</span>
      <span className="text-right text-ink">{v}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge py-14 text-center">
      <p className="text-sm text-muted">{title}</p>
      {hint ? <p className="max-w-md text-xs text-faint">{hint}</p> : null}
      {action}
    </div>
  );
}
