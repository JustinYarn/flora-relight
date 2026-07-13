"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Run, RunStatus } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { formatUsd } from "@/lib/cost";
import { EmptyState } from "@/components/ui";
import { LibraryRow } from "@/components/library/LibraryRow";
import { STATUS_META, shippedComposite } from "@/components/library/derive";

/*
 * The Library: a reader over the on-disk run store. Every past generation,
 * newest first, with progressive disclosure — collapsed rows → side-by-side
 * players + the 11 checks → per-check judge details.
 *
 * Data: the store's runs (persistence hydration already pulls data/runs/ on
 * boot) merged with a fresh GET /api/runs on mount, so runs finished by other
 * tabs or sessions appear without a reload. Store entries win by id — the
 * in-session store is fresher for runs it is actively driving.
 */

type StatusFilter = "all" | RunStatus;
type SortKey = "newest" | "score" | "cost";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "awaiting-review", label: STATUS_META["awaiting-review"].label },
  { key: "approved", label: STATUS_META.approved.label },
  { key: "needs-changes", label: STATUS_META["needs-changes"].label },
  { key: "failed", label: STATUS_META.failed.label },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "newest" },
  { key: "score", label: "highest score" },
  { key: "cost", label: "most expensive" },
];

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-md px-2.5 py-1 text-xs transition ${
        active ? "bg-raised text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({
  value,
  label,
  color,
  title,
}: {
  value: string;
  label: string;
  color?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div
        className="text-2xl font-semibold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      <div className="mt-0.5 text-2xs text-faint">{label}</div>
    </div>
  );
}

export function LibraryView() {
  const storeRuns = useAppStore((s) => s.runs);
  const hydrated = useAppStore((s) => s.hydrated);
  const passThreshold = useAppStore(
    (s) => s.workflow.config.compositePassThreshold
  );

  /** Freshness re-fetch: runs persisted by other tabs/sessions, merged below. */
  const [fetched, setFetched] = useState<Run[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    // hydrate() is idempotent (module-level promise) — this only ensures the
    // boot sync has been kicked off even if no other page ran it yet.
    void useAppStore.getState().hydrate();
    void fetch("/api/runs", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { runs?: unknown } | null) => {
        if (!cancelled && data && Array.isArray(data.runs)) {
          setFetched(data.runs as Run[]);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const runs = useMemo(() => {
    const merged = fetched
      ? [
          ...storeRuns,
          ...fetched.filter((r) => !storeRuns.some((s) => s.id === r.id)),
        ]
      : storeRuns;
    return [...merged].sort((a, b) => b.createdAt - a.createdAt);
  }, [storeRuns, fetched]);

  // Filters. liveOnly is tri-state: null = automatic (live only when any
  // live runs exist); the chip pins an explicit choice.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [liveOnly, setLiveOnly] = useState<boolean | null>(null);
  const [sort, setSort] = useState<SortKey>("newest");
  const [openId, setOpenId] = useState<string | null>(null);

  const anyLive = runs.some((r) => r.live);
  const effectiveLiveOnly = liveOnly ?? anyLive;

  /** Scope = the live/mock toggle; the header stats read this set. */
  const scoped = useMemo(
    () => (effectiveLiveOnly ? runs.filter((r) => r.live) : runs),
    [runs, effectiveLiveOnly]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = scoped.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q && !r.originalVideo.label.toLowerCase().includes(q)) return false;
      return true;
    });
    if (sort === "score") {
      return [...list].sort(
        (a, b) =>
          (shippedComposite(b)?.score ?? -1) - (shippedComposite(a)?.score ?? -1)
      );
    }
    if (sort === "cost") {
      return [...list].sort(
        (a, b) =>
          (b.cost?.actualUsd ?? 0) - (a.cost?.actualUsd ?? 0) ||
          (b.cost?.estimatedUsd ?? 0) - (a.cost?.estimatedUsd ?? 0)
      );
    }
    return list; // already newest first
  }, [scoped, search, statusFilter, sort]);

  // Header stats over the scoped set.
  const counts = useMemo(() => {
    let approved = 0;
    let needsChanges = 0;
    let awaiting = 0;
    for (const r of scoped) {
      if (r.status === "approved") approved += 1;
      else if (r.status === "needs-changes") needsChanges += 1;
      else if (r.status === "awaiting-review") awaiting += 1;
    }
    return { approved, needsChanges, awaiting };
  }, [scoped]);

  const avgScore = useMemo(() => {
    const scores = scoped
      .map((r) => shippedComposite(r)?.score)
      .filter((s): s is number => s !== undefined);
    if (scores.length === 0) return undefined;
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }, [scoped]);

  const spend = useMemo(
    () =>
      scoped.reduce(
        (acc, r) => ({
          actual: acc.actual + (r.cost?.actualUsd ?? 0),
          est: acc.est + (r.cost?.estimatedUsd ?? 0),
        }),
        { actual: 0, est: 0 }
      ),
    [scoped]
  );

  const filtersActive =
    search.trim() !== "" || statusFilter !== "all";

  return (
    <main className="mx-auto max-w-5xl px-6 pb-16 pt-8">
      <header className="flex items-baseline gap-3 pb-5">
        <h1 className="text-base font-semibold text-ink">Library</h1>
        <p className="text-2xs text-faint">
          every generation, straight from the run store on disk
        </p>
      </header>

      {/* HEADER STRIP — flat one-line stats, no cards */}
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4 border-b border-edge pb-5">
        <Stat value={String(scoped.length)} label="generations" />
        <Stat
          value={String(counts.approved)}
          label="approved"
          color="var(--pass)"
        />
        <Stat
          value={String(counts.needsChanges)}
          label="needs changes"
          color="var(--fail)"
        />
        <Stat
          value={String(counts.awaiting)}
          label="needs your review"
          color="var(--borderline)"
        />
        <Stat
          value={avgScore !== undefined ? avgScore.toFixed(1) : "—"}
          label="avg Overall score (shipped cuts)"
          title="mean Overall score of each run's shipped attempt"
        />
        <Stat
          value={formatUsd(spend.actual)}
          label={`actual spend · est. ${formatUsd(spend.est)}`}
          title="sum of every run's actual live spend; simulated runs spend $0"
        />
      </div>

      {/* FILTER ROW */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge py-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clips…"
          aria-label="Search clips by label"
          className="w-48 rounded-lg bg-raised px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:outline-none"
        />
        <span className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <Chip
              key={f.key}
              active={statusFilter === f.key}
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
            </Chip>
          ))}
        </span>
        <Chip
          active={effectiveLiveOnly}
          onClick={() => setLiveOnly(!effectiveLiveOnly)}
          title="hide simulated (mock) runs — they never spent real money"
        >
          live only
        </Chip>
        <span className="ml-auto flex items-center gap-1">
          <span className="mr-1 text-2xs uppercase tracking-[0.14em] text-faint">
            Sort
          </span>
          {SORTS.map((s) => (
            <Chip key={s.key} active={sort === s.key} onClick={() => setSort(s.key)}>
              {s.label}
            </Chip>
          ))}
        </span>
      </div>

      {/* THE LIST — flat rows, hairline dividers, single accordion */}
      {runs.length === 0 ? (
        <div className="pt-6">
          {hydrated ? (
            <EmptyState
              title="The library is empty"
              hint="As runs complete, every relit cut lands here automatically — before/after, your saved grade, any available automated evidence, and what it cost."
              action={
                <Link
                  href="/"
                  className="mt-1 rounded-lg border border-edge bg-raised px-3.5 py-1.5 text-sm text-ink transition hover:border-faint"
                >
                  Go to Studio
                </Link>
              }
            />
          ) : (
            <p className="py-10 text-center text-2xs text-faint">loading runs…</p>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">
          No runs match these filters.{" "}
          <button
            onClick={() => {
              setSearch("");
              setStatusFilter("all");
              if (effectiveLiveOnly) setLiveOnly(false);
            }}
            className="text-accent transition hover:brightness-110"
          >
            {filtersActive || effectiveLiveOnly ? "Show everything" : "Reset"}
          </button>
        </p>
      ) : (
        <div className="divide-y divide-edge border-b border-edge">
          {filtered.map((run) => (
            <LibraryRow
              key={run.id}
              run={run}
              passThreshold={passThreshold}
              open={openId === run.id}
              onToggle={() =>
                setOpenId((cur) => (cur === run.id ? null : run.id))
              }
              onDeleted={() => {
                // Drop the deleted run from the mount-time fetch snapshot too,
                // or the merge below would resurrect it from stale data.
                setFetched((cur) =>
                  cur ? cur.filter((r) => r.id !== run.id) : cur
                );
                setOpenId((cur) => (cur === run.id ? null : cur));
              }}
            />
          ))}
        </div>
      )}
    </main>
  );
}
