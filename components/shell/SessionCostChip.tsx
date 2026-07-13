"use client";

/**
 * Top-bar status cluster: persistence dot + spend chip + mode badge.
 *
 * MOCK mode (default): the chip is the standing "keep me in check" readout —
 * the summed pre-flight estimates of every run this session; nothing is
 * actually spent. LIVE mode: the badge flips to LIVE and the chip shows the
 * ACTUAL accrued spend (sum of run.cost.actualUsd) next to the estimate.
 *
 * This component is mounted once in the root layout, so it doubles as the
 * client-side boot point for persistence sync (startPersistence is
 * idempotent and inert when the /api routes are absent).
 */

import { useEffect } from "react";
import { sessionEstimatedSpend, useAppStore } from "@/lib/store";
import { formatUsd } from "@/lib/cost";
import {
  startPersistence,
  usePersistenceStatus,
  type PersistStatus,
} from "@/lib/persist";
import { Badge } from "@/components/ui";

const PERSIST_DOT: Record<
  Exclude<PersistStatus, "off">,
  { color: string; title: string }
> = {
  saved: {
    color: "var(--pass)",
    title: "Persistence: saved — runs and batches are synced to durable app storage",
  },
  saving: {
    color: "var(--running)",
    title: "Persistence: saving…",
  },
  error: {
    color: "var(--fail)",
    title:
      "Persistence: error — recent changes could not be saved to the server; retrying",
  },
};

export function SessionCostChip() {
  const runs = useAppStore((s) => s.runs);
  const mode = useAppStore((s) => s.mode);
  const persistStatus = usePersistenceStatus();

  useEffect(() => {
    startPersistence(useAppStore);
  }, []);

  const estUsd = sessionEstimatedSpend(runs);
  const actualUsd = runs.reduce((sum, r) => sum + (r.cost?.actualUsd ?? 0), 0);

  return (
    <span className="flex items-center gap-3">
      {persistStatus !== "off" ? (
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: PERSIST_DOT[persistStatus].color }}
          title={PERSIST_DOT[persistStatus].title}
        />
      ) : null}
      {mode === "live" ? (
        <span
          className="text-2xs tabular-nums text-faint"
          title="actual = accrued API spend this session · est = summed pre-flight run estimates"
        >
          actual: {formatUsd(actualUsd)} · est: {formatUsd(estUsd)}
        </span>
      ) : (
        <span
          className="text-2xs tabular-nums text-faint"
          title="What this session would have cost against live APIs — mock mode spends $0"
        >
          est. session: {formatUsd(estUsd)}
        </span>
      )}
      {mode === "live" ? (
        <Badge color="var(--pass)">LIVE — real API spend</Badge>
      ) : (
        <Badge color="var(--borderline)">MOCK MODE — no API keys</Badge>
      )}
    </span>
  );
}
