"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { probeVideo } from "@/lib/frames";
import { estimateBatch, estimateRun, formatUsd } from "@/lib/cost";
import { formatClock, uid } from "@/lib/util";
import { ConfirmSpend } from "@/components/shell/ConfirmSpend";
import {
  Badge,
  Card,
  ConfidenceMeter,
  EmptyState,
  ScoreMeter,
  SectionTitle,
} from "@/components/ui";
import type { Run, RunStatus, Verdict, VideoAsset } from "@/lib/types";

const PIPELINE_STEPS = [
  "Read clip",
  "Scene inventory",
  "Look Anchor",
  "Generate",
  "10 checks",
  "Review",
] as const;

/** Shape of a successful ingest response (POST /api/ingest and /api/ingest/finalize). */
interface IngestResponse {
  runId: string;
  url: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  trimmed: boolean;
  originalDurationSec: number;
  audioSha256: string | null;
}

/** One file's trip through server ingest, normalized for both flows. */
type IngestOutcome =
  | { ok: true; video: VideoAsset; trimNote: string | null; trimmedToSec: number | null }
  | { ok: false; serverMissing: boolean; error: string };

/**
 * Which storage driver the server runs — decides the upload path (fs →
 * multipart /api/ingest; blob → client-direct blob upload, because deployed
 * Vercel functions cap request bodies at 4.5MB). Fetched once per tab;
 * anything unexpected (404 in no-API environments, network failure) falls
 * back to "fs" so the existing multipart flow and its client-side fallback
 * behave exactly as before.
 */
let storageDriverPromise: Promise<"fs" | "blob"> | null = null;

function storageDriver(): Promise<"fs" | "blob"> {
  if (!storageDriverPromise) {
    storageDriverPromise = fetch("/api/storage/info")
      .then(async (res) => {
        if (!res.ok) return "fs" as const;
        const data = (await res.json().catch(() => null)) as { driver?: string } | null;
        return data?.driver === "blob" ? ("blob" as const) : ("fs" as const);
      })
      .catch(() => "fs" as const);
  }
  return storageDriverPromise;
}

/** Build the { ok: true } outcome both ingest flows share. */
function successOutcome(file: File, data: IngestResponse): IngestOutcome {
  return {
    ok: true,
    video: {
      id: uid("video"),
      kind: "original",
      url: data.url,
      label: file.name,
      durationSec: data.durationSec,
      width: data.width,
      height: data.height,
      hasAudio: data.hasAudio,
    },
    trimNote: data.trimmed
      ? `Trimmed from ${data.originalDurationSec.toFixed(1)}s to ${data.durationSec.toFixed(1)}s — the video model accepts at most 10s.`
      : null,
    trimmedToSec: data.trimmed ? data.durationSec : null,
  };
}

/** Local/fs path: the whole file goes through multipart POST /api/ingest. */
async function ingestViaMultipart(file: File): Promise<IngestOutcome> {
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/ingest", { method: "POST", body: form });
    if (res.ok) {
      return successOutcome(file, (await res.json()) as IngestResponse);
    }
    if (res.status === 404) {
      // No API routes in this environment — caller may fall back client-side.
      return {
        ok: false,
        serverMissing: true,
        error: `${file.name}: ingest API unavailable.`,
      };
    }
    const err = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
    return {
      ok: false,
      serverMissing: false,
      error: err?.error
        ? `${file.name}: ${err.error}`
        : `${file.name}: ingest failed (HTTP ${res.status}).`,
    };
  } catch {
    return {
      ok: false,
      serverMissing: true,
      error: `${file.name}: couldn't reach the ingest API.`,
    };
  }
}

/**
 * Cloud/blob path: upload DIRECTLY to Vercel Blob from the browser (client
 * token from /api/ingest/token — the gate cookie rides the same-origin
 * fetch), then POST /api/ingest/finalize, which runs the same probe → trim →
 * demux pipeline server-side and returns the identical response shape.
 */
async function ingestViaBlob(
  file: File,
  onProgress?: (percentage: number) => void
): Promise<IngestOutcome> {
  try {
    const { upload } = await import("@vercel/blob/client");
    // Safe basename only — the token route pins the uploads/ prefix and the
    // store appends a random suffix.
    const safeName = file.name.replace(/[^\w.-]+/g, "_") || "clip.mp4";
    const blob = await upload(`uploads/${safeName}`, file, {
      access: "public",
      handleUploadUrl: "/api/ingest/token",
      contentType: file.type || undefined,
      onUploadProgress: (event) => onProgress?.(event.percentage),
    });
    const res = await fetch("/api/ingest/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadUrl: blob.url, fileName: file.name }),
    });
    if (res.ok) {
      return successOutcome(file, (await res.json()) as IngestResponse);
    }
    const err = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
    return {
      ok: false,
      serverMissing: false,
      error: err?.error
        ? `${file.name}: ${err.error}`
        : `${file.name}: ingest failed (HTTP ${res.status}).`,
    };
  } catch (err) {
    // upload() throws on token-route rejections and transfer failures.
    return {
      ok: false,
      serverMissing: false,
      error: `${file.name}: ${err instanceof Error ? err.message : "upload failed."}`,
    };
  }
}

/**
 * Ingest one file through the server. Never throws — failures come back as
 * { ok: false } so the multi-file loop can collect errors without aborting.
 * `onProgress` only fires on the blob path (browser → store transfer).
 */
async function ingestOne(
  file: File,
  onProgress?: (percentage: number) => void
): Promise<IngestOutcome> {
  if ((await storageDriver()) === "blob") return ingestViaBlob(file, onProgress);
  return ingestViaMultipart(file);
}

const STATUS_META: Record<RunStatus, { color: string; label: string }> = {
  running: { color: "var(--running)", label: "running" },
  "awaiting-review": { color: "var(--borderline)", label: "needs your review" },
  approved: { color: "var(--pass)", label: "approved" },
  "needs-changes": { color: "var(--fail)", label: "needs changes" },
  failed: { color: "var(--fail)", label: "failed" },
};

function compositeVerdict(
  composite: { score: number; passed: boolean },
  passThreshold: number
): Verdict {
  if (composite.passed) return "pass";
  // Score cleared the bar but a hard gate failed → borderline, else fail.
  return composite.score >= passThreshold ? "borderline" : "fail";
}

function RunRow({ run, maxIterations, passThreshold, inBatch }: {
  run: Run;
  maxIterations: number;
  passThreshold: number;
  inBatch: boolean;
}) {
  const router = useRouter();
  const latest = run.iterations.at(-1);
  const composite = latest?.composite;
  const evals = latest?.evalResults ?? [];
  const meanConfidence =
    evals.length > 0
      ? evals.reduce((sum, r) => sum + r.confidence, 0) / evals.length
      : undefined;
  const status = STATUS_META[run.status];

  return (
    <tr
      onClick={() => router.push(`/runs/${run.id}`)}
      className="cursor-pointer border-t border-edge transition-colors hover:bg-raised"
    >
      <td className="px-4 py-3">
        <Link
          href={`/runs/${run.id}`}
          onClick={(e) => e.stopPropagation()}
          className="block text-inherit no-underline"
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-ink">{run.id.slice(0, 14)}</span>
            {inBatch ? <Badge>batch</Badge> : null}
          </div>
          <div className="mt-0.5 max-w-[220px] truncate text-2xs text-faint">
            {run.originalVideo.label}
          </div>
        </Link>
      </td>
      <td className="px-4 py-3">
        <Badge color={status.color}>{status.label}</Badge>
      </td>
      <td className="px-4 py-3 text-sm tabular-nums text-muted">
        {run.iterations.length}/{maxIterations}
      </td>
      <td className="w-40 px-4 py-3">
        {composite ? (
          <ScoreMeter
            score={composite.score}
            verdict={compositeVerdict(composite, passThreshold)}
          />
        ) : (
          <span className="text-sm text-faint">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {meanConfidence !== undefined ? (
          <ConfidenceMeter confidence={meanConfidence} />
        ) : (
          <span className="text-sm text-faint">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs tabular-nums text-faint">
        {formatClock(run.createdAt)}
      </td>
    </tr>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const runs = useAppStore((s) => s.runs);
  const workflow = useAppStore((s) => s.workflow);
  const startRun = useAppStore((s) => s.startRun);
  const startBatch = useAppStore((s) => s.startBatch);
  const batches = useAppStore((s) => s.batches);
  const mode = useAppStore((s) => s.mode);

  /** Every run id that belongs to some batch — drives the "batch" row tag. */
  const batchRunIds = useMemo(
    () => new Set((batches ?? []).flatMap((b) => b.runIds)),
    [batches]
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  /** Multi-file loop status shown in the dropzone ("Ingesting 2/5 — …"). */
  const [progress, setProgress] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  /** Non-fatal ingest note (e.g. auto-trim) — borderline color, not fail. */
  const [ingestInfo, setIngestInfo] = useState<string | null>(null);
  /** Live mode: an ingested clip waiting for spend confirmation. */
  const [pendingLaunch, setPendingLaunch] = useState<{
    video: VideoAsset;
    trimNote: string | null;
  } | null>(null);
  /** Multi-drop: ingested clips waiting for one batch spend confirmation. */
  const [pendingBatch, setPendingBatch] = useState<{
    assets: VideoAsset[];
  } | null>(null);
  /** Raw budget-cap field for the batch confirm — empty means "no cap". */
  const [budgetInput, setBudgetInput] = useState("");

  /** Accumulate per-file errors on one line without clobbering earlier ones. */
  const appendError = useCallback((msg: string) => {
    setIngestError((prev) => (prev ? `${prev} · ${msg}` : msg));
  }, []);

  const handleSingle = useCallback(
    async (file: File) => {
      // Server ingest first: persists the clip via the storage driver and
      // auto-trims anything over the 10s video-model input cap. The run
      // MUST carry the returned server url — live videogen resolves the
      // actual file from it. Progress only fires on the blob upload path.
      const outcome = await ingestOne(file, (pct) =>
        setProgress(
          pct < 100
            ? `Uploading ${file.name} — ${Math.round(pct)}%…`
            : `Processing ${file.name}…`
        )
      );
      let video: VideoAsset | null = null;
      let trimNote: string | null = null;
      if (outcome.ok) {
        video = outcome.video;
        trimNote = outcome.trimNote;
      } else if (!outcome.serverMissing) {
        appendError(outcome.error);
        return;
      } else {
        // Client-side probe fallback (no-API environments): the clip
        // stays in this browser tab as an object URL.
        const url = URL.createObjectURL(file);
        try {
          const probe = await probeVideo(url);
          video = {
            id: uid("video"),
            kind: "original",
            url,
            label: file.name,
            durationSec: probe.durationSec,
            width: probe.width,
            height: probe.height,
            hasAudio: probe.hasAudio,
          };
        } catch {
          URL.revokeObjectURL(url);
          appendError(
            `Couldn't read "${file.name}" as a video — try a different clip.`
          );
          return;
        }
      }

      if (trimNote) setIngestInfo(trimNote);

      if (mode === "live") {
        // Real spend ahead — route the auto-start through ConfirmSpend.
        setPendingLaunch({ video, trimNote });
        return;
      }
      const id = startRun(video);
      router.push(`/runs/${id}`);
    },
    [appendError, mode, router, startRun]
  );

  const handleMany = useCallback(
    async (files: File[]) => {
      const assets: VideoAsset[] = [];
      const trimmedToSecs: number[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Ingesting ${i + 1}/${files.length} — ${files[i].name}…`);
        // Blob-path uploads report transfer progress into the same line.
        const outcome = await ingestOne(files[i], (pct) =>
          setProgress(
            pct < 100
              ? `Ingesting ${i + 1}/${files.length} — ${files[i].name} (${Math.round(pct)}%)…`
              : `Ingesting ${i + 1}/${files.length} — ${files[i].name} (processing)…`
          )
        );
        if (outcome.ok) {
          assets.push(outcome.video);
          if (outcome.trimmedToSec !== null) {
            trimmedToSecs.push(outcome.trimmedToSec);
          }
        } else {
          // Per-file failure — report it, keep going with the rest.
          appendError(outcome.error);
        }
      }
      if (trimmedToSecs.length > 0) {
        setIngestInfo(
          `${trimmedToSecs.length} ${trimmedToSecs.length === 1 ? "clip" : "clips"} trimmed to ${trimmedToSecs[0].toFixed(1)}s — the video model accepts at most 10s.`
        );
      }
      if (assets.length === 0) return;
      setBudgetInput("");
      setPendingBatch({ assets });
    },
    [appendError]
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (ingesting || files.length === 0) return;
      setIngesting(true);
      setIngestError(null);
      setIngestInfo(null);
      try {
        const videos = files.filter((f) => {
          if (f.type.startsWith("video/")) return true;
          appendError(
            `Couldn't read "${f.name}" as a video — try a different clip.`
          );
          return false;
        });
        if (videos.length === 0) return;
        if (videos.length === 1) {
          await handleSingle(videos[0]);
        } else {
          await handleMany(videos);
        }
      } finally {
        setIngesting(false);
        setProgress(null);
      }
    },
    [appendError, handleMany, handleSingle, ingesting]
  );

  /** Parsed budget cap for the pending batch — undefined means "no cap". */
  const parsedBudgetUsd = useMemo(() => {
    if (budgetInput.trim() === "") return undefined;
    const n = Number(budgetInput);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [budgetInput]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-8">
      <div className="grid gap-5 lg:grid-cols-5">
        {/* Hero */}
        <Card className="p-5 lg:col-span-3">
          <SectionTitle>What this tool does</SectionTitle>
          <p className="text-sm leading-relaxed text-muted">
            Drop in a dim webcam clip — get the same clip professionally relit,
            gated by 11 checks, with the original audio untouched by
            construction.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {PIPELINE_STEPS.map((step, i) => (
              <span key={step} className="flex items-center gap-1.5">
                <span className="rounded-md border border-edge bg-raised px-2 py-1 text-2xs font-medium text-muted">
                  {step}
                </span>
                {i < PIPELINE_STEPS.length - 1 ? (
                  <span className="text-2xs text-faint">→</span>
                ) : null}
              </span>
            ))}
          </div>
        </Card>

        {/* New run */}
        <Card className="p-5 lg:col-span-2">
          <SectionTitle>New run</SectionTitle>
          <div
            role="button"
            tabIndex={0}
            aria-disabled={ingesting}
            onClick={() => {
              if (!ingesting) inputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !ingesting) {
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void handleFiles(Array.from(e.dataTransfer.files));
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
              dragging
                ? "border-accent bg-accent-soft"
                : "border-edge hover:border-faint"
            }`}
          >
            <p className="text-sm text-ink">
              {ingesting
                ? progress ?? "Reading your clip…"
                : "Drop webcam clips, or click to browse"}
            </p>
            <p className="text-2xs text-faint">
              video/* · drop one clip for a single run, or several to launch a
              batch — each starts with a cost confirmation
            </p>
          </div>
          {ingestError ? (
            <p className="mt-2 text-2xs text-fail">{ingestError}</p>
          ) : null}
          {ingestInfo ? (
            <p className="mt-2 text-2xs text-borderline">{ingestInfo}</p>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <p className="mt-2 text-2xs leading-relaxed text-faint">
            ~10s webcam clips work best · longer clips are auto-trimmed to the
            10s model cap · uploads stay on your machine (data/ on the dev
            server)
          </p>
        </Card>
      </div>

      {/* Runs table */}
      <Card className="p-5">
        <SectionTitle
          right={
            <span className="text-2xs tabular-nums text-faint">
              {runs.length} {runs.length === 1 ? "run" : "runs"}
            </span>
          }
        >
          Runs
        </SectionTitle>
        {runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            hint="Drop a clip above to start your first run — or drop several at once to launch a batch."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="text-2xs uppercase tracking-[0.14em] text-faint">
                  <th className="px-4 pb-2 font-medium">Run</th>
                  <th className="px-4 pb-2 font-medium">Status</th>
                  <th className="px-4 pb-2 font-medium">Attempts</th>
                  <th
                    className="px-4 pb-2 font-medium"
                    title="Overall score (weighted composite of all checks)"
                  >
                    Overall score
                  </th>
                  <th className="px-4 pb-2 font-medium">Confidence</th>
                  <th className="px-4 pb-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    maxIterations={workflow.config.maxIterations}
                    passThreshold={workflow.config.compositePassThreshold}
                    inBatch={batchRunIds.has(run.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Live mode only: uploads confirm their spend before the run starts. */}
      {pendingLaunch ? (
        <ConfirmSpend
          title="Start live run?"
          lines={[
            `${pendingLaunch.video.label} — ${pendingLaunch.video.durationSec.toFixed(1)}s`,
            `Estimated live cost: ${formatUsd(estimateRun(pendingLaunch.video.durationSec).totalUsd)}`,
            `Up to ${workflow.config.maxIterations} attempts; you can stop between attempts.`,
            ...(pendingLaunch.trimNote ? [pendingLaunch.trimNote] : []),
          ]}
          confirmLabel="Run live"
          onConfirm={() => {
            const id = startRun(pendingLaunch.video);
            setPendingLaunch(null);
            router.push(`/runs/${id}`);
          }}
          onCancel={() => setPendingLaunch(null)}
        />
      ) : null}

      {/* Multi-drop: one spend confirmation for the whole upload batch. */}
      {pendingBatch ? (
        <ConfirmSpend
          title={`Start batch of ${pendingBatch.assets.length} clips?`}
          lines={[
            `Total estimated live cost: ${formatUsd(estimateBatch(pendingBatch.assets).totalUsd)}`,
            ...pendingBatch.assets.map(
              (a) =>
                `${a.label} — ${a.durationSec.toFixed(1)}s · est. ${formatUsd(estimateRun(a.durationSec).totalUsd)}`
            ),
          ]}
          confirmLabel="Start batch"
          onConfirm={() => {
            startBatch(
              pendingBatch.assets,
              `Upload batch ${new Date().toLocaleDateString()}`,
              { budgetUsd: parsedBudgetUsd }
            );
            setPendingBatch(null);
            router.push("/batch");
          }}
          onCancel={() => setPendingBatch(null)}
        >
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Budget cap in USD (optional) — runs whose estimate would exceed it
            are skipped
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="no cap"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              className="rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-sm text-ink focus:outline-none"
            />
          </label>
        </ConfirmSpend>
      ) : null}
    </div>
  );
}
