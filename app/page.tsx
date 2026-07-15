"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/lib/store";
import { probeVideo } from "@/lib/frames";
import {
  estimateFirstCut,
  estimateLampRun,
  FIRST_CUT_MAX_OUTPUT_SECONDS,
  formatUsd,
  lampRunReservationUsd,
  omniGenerationReservationUsd,
} from "@/lib/cost";
import { formatClock, uid } from "@/lib/util";
import { ConfirmSpend } from "@/components/shell/ConfirmSpend";
import { WorkflowModeSelector } from "@/components/shell/WorkflowModeSelector";
import {
  Badge,
  Button,
  Card,
  ConfidenceMeter,
  EmptyState,
  ScoreMeter,
  SectionTitle,
} from "@/components/ui";
import type {
  Run,
  RunStatus,
  Verdict,
  VideoAsset,
  WorkflowMode,
} from "@/lib/types";
import { workflowModeLabel } from "@/lib/workflow-mode";
import { parseOptionalPositiveBudgetUsd } from "@/lib/budget-input";

const FLORA_FLOW = [
  {
    title: "One-pass generation",
    description: "Generate one review-ready relight for each source video.",
  },
  {
    title: "Original audio",
    description: "Restore and verify the source audio on the delivered cut.",
  },
  {
    title: "Human review",
    description: "Inspect the cut directly and decide whether it is ready to use.",
  },
  {
    title: "Single or batch",
    description: "Run one clip or send a group through the bounded batch queue.",
  },
] as const;

const LAMP_FLOW = [
  {
    title: "Initial video",
    description: "Generate once from the complete mega prompt.",
  },
  {
    title: "Whole-video critique",
    description:
      "Evaluate the full result together. Only checks that actually return are recorded.",
  },
  {
    title: "Final video",
    description: "Apply the critique in one final regeneration — no open-ended loop.",
  },
  {
    title: "Your grade",
    description:
      "Grade the final blind, then compare your calls with the available final AI evaluation.",
  },
] as const;

const MODE_COPY: Record<
  WorkflowMode,
  { eyebrow: string; title: string; description: string }
> = {
  flora: {
    eyebrow: "Legacy one-pass method",
    title: "Fast first cuts, one video or a batch.",
    description:
      "Flora generates one review-ready relight per source clip, preserves the original audio, and sends the result to human review.",
  },
  lamp: {
    eyebrow: "Exact two-pass method",
    title: "One critique. One regeneration. One final.",
    description:
      "Lamp generates an Initial from the mega prompt, critiques the complete video, and regenerates once. You grade Final blind before comparing your calls with the AI evaluation.",
  },
};

function estimateWorkflowRun(mode: WorkflowMode, durationSec: number) {
  return mode === "lamp"
    ? estimateLampRun(durationSec)
    : estimateFirstCut(durationSec);
}

function workflowReservationUsd(mode: WorkflowMode): number {
  return mode === "lamp"
    ? lampRunReservationUsd(FIRST_CUT_MAX_OUTPUT_SECONDS)
    : omniGenerationReservationUsd(FIRST_CUT_MAX_OUTPUT_SECONDS);
}

/** Display the next whole cent so a matching optional cap can admit the clip. */
function formatReservationUsd(usd: number): string {
  return `$${(Math.ceil(usd * 100) / 100).toFixed(2)}`;
}

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

type ReadinessState =
  | { phase: "checking" }
  | { phase: "ready"; durable: boolean; driver: "fs" | "blob" }
  | { phase: "blocked"; message: string };

interface ReadinessResponse {
  ready?: boolean;
  durable?: boolean;
  ffmpegReady?: boolean;
  storage?: {
    driver?: "fs" | "blob" | null;
    missing?: Array<"blob" | "database" | "private_blob_access">;
  };
}

/** Redacted server projection; private Blob pathnames never reach the browser. */
interface PendingIngestUpload {
  runId: string;
  fileName: string;
  createdAt: number;
  completed: boolean;
}

/**
 * Which storage driver the server runs — decides the upload path (fs →
 * multipart /api/ingest; blob → client-direct blob upload, because deployed
 * Vercel functions cap request bodies at 4.5MB). Fetched once per tab. A
 * hosted readiness/configuration error must never be translated into the
 * local filesystem path: that would only defer the failure until bytes have
 * already started moving.
 */
let storageDriverPromise: Promise<"fs" | "blob"> | null = null;

function storageDriver(): Promise<"fs" | "blob"> {
  if (!storageDriverPromise) {
    const request = fetch("/api/storage/info").then(async (res) => {
      const data = (await res.json().catch(() => null)) as
        | {
            driver?: string | null;
            error?: string;
            cloud?: { blobAccess?: string; privateAccessConfigured?: boolean };
          }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Storage is unavailable (HTTP ${res.status}).`);
      }
      if (data?.driver !== "fs" && data?.driver !== "blob") {
        throw new Error("The server did not report a usable storage driver.");
      }
      if (
        data.driver === "blob" &&
        (data.cloud?.blobAccess !== "private" ||
          data.cloud.privateAccessConfigured !== true)
      ) {
        throw new Error("Hosted uploads require an explicitly private Blob store.");
      }
      return data.driver;
    });
    storageDriverPromise = request.catch((error) => {
      // A transient readiness/network failure should be retryable without a
      // full page reload; successful selections remain cached for this tab.
      storageDriverPromise = null;
      throw error;
    });
  }
  return storageDriverPromise;
}

/** Build the { ok: true } outcome both ingest flows share. */
function successOutcome(file: File, data: IngestResponse): IngestOutcome {
  return {
    ok: true,
    video: {
      id: uid("video"),
      runId: data.runId,
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
async function ingestViaMultipart(file: File, runId: string): Promise<IngestOutcome> {
  try {
    const form = new FormData();
    form.append("file", file);
    form.append("runId", runId);
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
  runId: string,
  onProgress?: (percentage: number) => void
): Promise<IngestOutcome> {
  try {
    const { upload } = await import("@vercel/blob/client");
    const extension = /\.(mp4|m4v|mov|webm|mkv|avi)$/i.exec(file.name)?.[0]?.toLowerCase()
      ?? ".mp4";
    const inferredContentType: Record<string, string> = {
      ".mp4": "video/mp4",
      ".m4v": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".avi": "video/x-msvideo",
    };
    const contentType = file.type.startsWith("video/")
      ? file.type
      : inferredContentType[extension] ?? "video/mp4";
    // The deterministic, run-owned pathname plus the token route's durable
    // reservation lets a later session recover an upload that finished just
    // before this tab closed. The private provider URL is intentionally
    // ignored; canonical media URLs are always same-origin /api/media paths.
    await upload(`uploads/${runId}/raw${extension}`, file, {
      access: "private",
      handleUploadUrl: "/api/ingest/token",
      clientPayload: JSON.stringify({ runId, fileName: file.name }),
      // Empty/application-octet-stream MIME values are common for videos
      // selected from desktop file systems. The upload token only permits
      // video/*, so bind a safe type from the already-validated extension.
      contentType,
      multipart: true,
      onUploadProgress: (event) => onProgress?.(event.percentage),
    });
    const res = await fetch("/api/ingest/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
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
  runId: string,
  onProgress?: (percentage: number) => void
): Promise<IngestOutcome> {
  try {
    if ((await storageDriver()) === "blob") return ingestViaBlob(file, runId, onProgress);
    return ingestViaMultipart(file, runId);
  } catch (error) {
    return {
      ok: false,
      serverMissing: false,
      error: `${file.name}: ${
        error instanceof Error ? error.message : "storage is unavailable."
      }`,
    };
  }
}

/**
 * Batch preparation is valuable state, so force one immediate durable write
 * before uploading bytes and after every member settles. The normal store
 * subscriber still handles later workflow mutations.
 */
async function persistBatchSnapshot(): Promise<void> {
  const res = await fetch("/api/batches", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batches: useAppStore.getState().batches }),
  });
  if (!res.ok) {
    throw new Error(`batch persistence failed (HTTP ${res.status})`);
  }
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

function isResumableSingleRun(
  run: Run,
  batchRunIds: ReadonlySet<string>,
  now = Date.now()
): boolean {
  if (
    batchRunIds.has(run.id) ||
    run.status !== "running"
  ) {
    return false;
  }
  if (run.serverExecution?.status === "user_action_required") {
    return run.serverExecution.source === "single";
  }
  if (run.iterations.length !== 0) return false;
  if (!run.spendApproval && !run.serverExecution) return true;
  return (
    run.spendApproval?.source === "single" &&
    run.spendApproval.expiresAt <= now &&
    (!run.serverExecution || run.serverExecution.status === "queued")
  );
}

function RunRow({ run, passThreshold, inBatch, readyToStart }: {
  run: Run;
  passThreshold: number;
  inBatch: boolean;
  readyToStart: boolean;
}) {
  const router = useRouter();
  const latest = run.iterations.at(-1);
  const composite = latest?.composite;
  const evals = latest?.evalResults ?? [];
  const meanConfidence =
    evals.length > 0
      ? evals.reduce((sum, r) => sum + r.confidence, 0) / evals.length
      : undefined;
  const isLampRun = run.workflowMode === "lamp";
  const status = readyToStart
    ? run.serverExecution?.status === "user_action_required"
      ? { color: "var(--borderline)", label: "approval needed" }
      : { color: "var(--running)", label: "ready to start" }
    : STATUS_META[run.status];

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
            <Badge color={run.workflowMode === "lamp" ? "var(--accent)" : "var(--muted)"}>
              {workflowModeLabel(run.workflowMode ?? "flora")}
            </Badge>
          </div>
          <div className="mt-0.5 max-w-[220px] truncate text-2xs text-faint">
            {run.originalVideo.label}
          </div>
        </Link>
      </td>
      <td className="px-4 py-3">
        <Badge color={status.color}>{status.label}</Badge>
      </td>
      <td className="px-4 py-3 text-sm text-muted">
        {run.status === "failed"
          ? isLampRun && run.iterations.length >= 2
            ? "Stopped after final"
            : run.iterations.length === 1
              ? isLampRun
                ? "Stopped after initial"
                : "Stopped after first cut"
              : "Not started"
          : isLampRun && run.iterations.length >= 2
            ? "Final ready"
            : run.iterations.length === 1
              ? isLampRun
                ? "Initial ready"
                : "First cut ready"
              : "—"}
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
  const createBatchDraft = useAppStore((s) => s.createBatchDraft);
  const updateBatchUpload = useAppStore((s) => s.updateBatchUpload);
  const startBatchFromDraft = useAppStore((s) => s.startBatchFromDraft);
  const batches = useAppStore((s) => s.batches);
  const mode = useAppStore((s) => s.mode);
  const workflowMode = useAppStore((s) => s.workflowMode);
  const hydrated = useAppStore((s) => s.hydrated);

  /** Every run id that belongs to some batch — drives the "batch" row tag. */
  const batchRunIds = useMemo(
    () => new Set((batches ?? []).flatMap((b) => b.runIds)),
    [batches]
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const receiptChecksRef = useRef(new Set<string>());
  const singleReceiptChecksRef = useRef(new Set<string>());
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
    workflowMode: WorkflowMode;
  } | null>(null);
  /** Server-discovered single uploads that have not become prepared Runs yet. */
  const [pendingSingleUploads, setPendingSingleUploads] = useState<
    PendingIngestUpload[]
  >([]);
  /** Durable multi-drop waiting for one batch spend confirmation. */
  const [pendingBatchId, setPendingBatchId] = useState<string | null>(null);
  /** Raw budget-cap field for the batch confirm — empty means "no cap". */
  const [budgetInput, setBudgetInput] = useState("");
  const [launching, setLaunching] = useState<"run" | "batch" | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ReadinessState>({ phase: "checking" });

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/readiness", { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as ReadinessResponse | null;
        if (cancelled) return;
        const driver = data?.storage?.driver;
        if (res.ok && data?.ready && (driver === "fs" || driver === "blob")) {
          setReadiness({
            phase: "ready",
            durable: data.durable === true,
            driver,
          });
          return;
        }

        const missing = data?.storage?.missing ?? [];
        const missingNames = missing.map((item) =>
          item === "blob"
            ? "a private Blob store"
            : item === "database"
              ? "the database"
              : "private Blob access"
        );
        const message =
          missing.length > 0
            ? `Uploads are paused until ${missingNames.join(" and ")} ${
                missing.length === 1 ? "is" : "are"
              } configured.`
            : data?.ffmpegReady === false
              ? "Uploads are paused because the video processor is unavailable on this deployment."
              : "Uploads are paused because production readiness could not be verified.";
        setReadiness({ phase: "blocked", message });
      })
      .catch(() => {
        if (!cancelled) {
          setReadiness({
            phase: "blocked",
            message: "Uploads are paused because the server readiness check could not be reached.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || readiness.phase !== "ready" || readiness.driver !== "blob") {
      return;
    }
    const candidates = useAppStore.getState().batches.flatMap((batch) =>
      (batch.uploads ?? [])
        // The browser may close after server finalization but before even the
        // `uploading` checkpoint lands, so a durable receipt can belong to any
        // non-ready draft item, including the initial `pending` state.
        .filter((item) => item.status !== "ready")
        .map((item) => ({ batchId: batch.id, item }))
    );
    const receiptChecks = receiptChecksRef.current;
    const unchecked = candidates.filter(
      ({ item }) => !receiptChecks.has(item.runId)
    );
    if (unchecked.length === 0) return;
    for (const { item } of unchecked) receiptChecks.add(item.runId);

    const controller = new AbortController();
    void (async () => {
      let recovered = 0;
      for (const { batchId, item } of unchecked) {
        try {
          const response = await fetch(
            `/api/ingest/status?runId=${encodeURIComponent(item.runId)}`,
            { cache: "no-store", signal: controller.signal }
          );
          if (!response.ok) continue;
          const payload = (await response.json()) as {
            result?: IngestResponse;
            recoverable?: boolean;
          };
          let result: IngestResponse | undefined;
          if (payload.result || payload.recoverable) {
            const finalize = await fetch("/api/ingest/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ runId: item.runId }),
              signal: controller.signal,
            });
            // Even when status found a committed receipt, replay finalize: the
            // first function may have died between receipt and prepared-Run
            // persistence. Finalize is the idempotent materialization boundary.
            if (finalize.ok) result = (await finalize.json()) as IngestResponse;
          }
          if (!result || result.runId !== item.runId || controller.signal.aborted) {
            continue;
          }
          updateBatchUpload(batchId, item.runId, {
            status: "ready",
            error: undefined,
            video: {
              id: uid("video"),
              runId: result.runId,
              kind: "original",
              url: result.url,
              label: item.label,
              durationSec: result.durationSec,
              width: result.width,
              height: result.height,
              hasAudio: result.hasAudio,
            },
          });
          recovered += 1;
        } catch {
          // A transient status read is safe to retry after the next reload.
        }
      }
      if (controller.signal.aborted || recovered === 0) return;
      try {
        await persistBatchSnapshot();
        setIngestInfo(
          `${recovered} completed ${recovered === 1 ? "upload was" : "uploads were"} recovered from durable storage.`
        );
      } catch {
        setIngestError(
          "Recovered upload media was found, but its batch checkpoint could not be saved. Reload to retry."
        );
      }
    })();

    return () => {
      controller.abort();
      for (const { item } of unchecked) {
        receiptChecks.delete(item.runId);
      }
    };
  }, [hydrated, readiness, updateBatchUpload]);

  useEffect(() => {
    if (!hydrated || readiness.phase !== "ready" || readiness.driver !== "blob") {
      return;
    }
    const controller = new AbortController();
    const ownedChecks: string[] = [];
    const receiptChecks = singleReceiptChecksRef.current;

    void (async () => {
      try {
        const listResponse = await fetch("/api/ingest/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!listResponse.ok || controller.signal.aborted) return;
        const listed = (await listResponse.json()) as { uploads?: unknown };
        if (!Array.isArray(listed.uploads)) return;
        const uploads = listed.uploads.filter(
          (value): value is PendingIngestUpload =>
            typeof value === "object" &&
            value !== null &&
            typeof value.runId === "string" &&
            typeof value.fileName === "string" &&
            typeof value.createdAt === "number" &&
            typeof value.completed === "boolean"
        );
        // Batch drafts already own their recovery UI. Everything else is a
        // single selection whose token route durably reserved it before bytes
        // moved, including reservations made by an older deployment.
        const singles = uploads.filter((upload) => !batchRunIds.has(upload.runId));
        setPendingSingleUploads(singles);

        let recovered = 0;
        for (const upload of singles) {
          if (controller.signal.aborted) return;
          if (receiptChecks.has(upload.runId)) continue;
          receiptChecks.add(upload.runId);
          ownedChecks.push(upload.runId);
          try {
            const statusResponse = await fetch(
              `/api/ingest/status?runId=${encodeURIComponent(upload.runId)}`,
              { cache: "no-store", signal: controller.signal }
            );
            if (!statusResponse.ok) continue;
            const status = (await statusResponse.json()) as {
              result?: IngestResponse;
              recoverable?: boolean;
            };
            let result: IngestResponse | undefined;
            if (status.result || status.recoverable) {
              const finalize = await fetch("/api/ingest/finalize", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runId: upload.runId }),
                signal: controller.signal,
              });
              // A receipt alone is not enough: replay the idempotent finalize
              // boundary so a crash before prepared-Run persistence is repaired.
              if (finalize.ok) result = (await finalize.json()) as IngestResponse;
            }
            if (!result || result.runId !== upload.runId || controller.signal.aborted) {
              continue;
            }

            // Finalize creates the normal prepared Run server-side. Pull that
            // canonical document into this already-hydrated tab so the existing
            // spend-confirmation card appears without another reload.
            const runResponse = await fetch(
              `/api/runs?id=${encodeURIComponent(upload.runId)}`,
              { cache: "no-store", signal: controller.signal }
            );
            const runPayload = (await runResponse.json().catch(() => null)) as
              | { run?: Run }
              | null;
            if (!runResponse.ok || !runPayload?.run || controller.signal.aborted) {
              continue;
            }
            useAppStore.setState((state) => ({
              runs: [
                runPayload.run as Run,
                ...state.runs.filter((run) => run.id !== upload.runId),
              ].sort((a, b) => b.createdAt - a.createdAt),
            }));
            setPendingSingleUploads((current) =>
              current.filter((item) => item.runId !== upload.runId)
            );
            recovered += 1;
          } catch {
            // A transient status/finalize/read failure is safe to retry after
            // the effect restarts or the page reloads; all durable ids remain.
          }
        }
        if (recovered > 0 && !controller.signal.aborted) {
          setIngestInfo(
            `${recovered} single ${recovered === 1 ? "upload was" : "uploads were"} recovered from durable storage.`
          );
        }
      } catch {
        // Hydrated history remains usable; pending-ingest discovery can retry
        // on a later readiness/batch change or page load.
      }
    })();

    return () => {
      controller.abort();
      for (const runId of ownedChecks) {
        receiptChecks.delete(runId);
      }
    };
  }, [batchRunIds, hydrated, readiness]);

  const pendingBatch = pendingBatchId
    ? batches.find((batch) => batch.id === pendingBatchId)
    : undefined;
  const pendingBatchAssets = useMemo(
    () =>
      (pendingBatch?.uploads ?? [])
        .filter(
          (item): item is typeof item & { video: VideoAsset } =>
            item.status === "ready" && item.video !== undefined
        )
        .map((item) => item.video),
    [pendingBatch]
  );
  /** Newest prepared batch can be resumed after a refresh or modal cancel. */
  const resumableBatch = useMemo(
    () =>
      batches.find(
        (batch) =>
          (batch.status === "ready" || batch.status === "uploading") &&
          (batch.uploads ?? []).some(
            (item) => item.status === "ready" && item.video !== undefined
          )
      ),
    [batches]
  );
  /** Every prepared or approval-paused single remains independently resumable. */
  const resumableSingles = useMemo(
    () => runs.filter((run) => isResumableSingleRun(run, batchRunIds)),
    [batchRunIds, runs]
  );
  const interruptedSingle = pendingSingleUploads[0];

  /** Accumulate per-file errors on one line without clobbering earlier ones. */
  const appendError = useCallback((msg: string) => {
    setIngestError((prev) => (prev ? `${prev} · ${msg}` : msg));
  }, []);

  const handleSingle = useCallback(
    async (file: File) => {
      // Re-selecting the same interrupted single clip reuses its durable
      // reservation. Otherwise reserve a fresh canonical id; the Blob token
      // route commits that discoverable checkpoint before transfer begins.
      const savedUpload = pendingSingleUploads.find(
        (upload) => upload.fileName === file.name
      );
      const runId = savedUpload?.runId ?? uid("run");
      // Server ingest first: persists the clip via the storage driver and
      // auto-trims anything over the 10s video-model input cap. The run
      // MUST carry the returned server url — live videogen resolves the
      // actual file from it. Progress only fires on the blob upload path.
      const outcome = await ingestOne(file, runId, (pct) =>
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
        setPendingSingleUploads((current) =>
          current.filter((upload) => upload.runId !== runId)
        );
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
            runId,
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
        setLaunchError(null);
        setPendingLaunch({ video, trimNote, workflowMode });
        return;
      }
      try {
        const id = await startRun(video, { workflowMode });
        router.push(`/runs/${id}`);
      } catch (error) {
        appendError(
          error instanceof Error ? error.message : "The run could not be saved before starting."
        );
      }
    },
    [appendError, mode, pendingSingleUploads, router, startRun, workflowMode]
  );

  const handleMany = useCallback(
    async (files: File[]) => {
      const reservations = files.map((file) => ({
        runId: uid("run"),
        label: file.name,
      }));
      const batchId = createBatchDraft(
        reservations,
        `${workflowModeLabel(workflowMode)} batch ${new Date().toLocaleDateString()}`,
        workflowMode
      );
      try {
        await persistBatchSnapshot();
      } catch {
        for (const reservation of reservations) {
          updateBatchUpload(batchId, reservation.runId, {
            status: "failed",
            error: "Could not save the batch before upload.",
          });
        }
        appendError(
          "Batch storage is unavailable, so no videos were uploaded. Check production readiness and try again."
        );
        return;
      }
      const assets: VideoAsset[] = [];
      const trimmedToSecs: number[] = [];
      for (let i = 0; i < files.length; i++) {
        const runId = reservations[i].runId;
        updateBatchUpload(batchId, runId, {
          status: "uploading",
          error: undefined,
        });
        setProgress(`Ingesting ${i + 1}/${files.length} — ${files[i].name}…`);
        // Blob-path uploads report transfer progress into the same line.
        const outcome = await ingestOne(files[i], runId, (pct) =>
          setProgress(
            pct < 100
              ? `Ingesting ${i + 1}/${files.length} — ${files[i].name} (${Math.round(pct)}%)…`
              : `Ingesting ${i + 1}/${files.length} — ${files[i].name} (processing)…`
          )
        );
        if (outcome.ok) {
          assets.push(outcome.video);
          updateBatchUpload(batchId, runId, {
            status: "ready",
            video: outcome.video,
            error: undefined,
          });
          if (outcome.trimmedToSec !== null) {
            trimmedToSecs.push(outcome.trimmedToSec);
          }
        } else {
          // Per-file failure — report it, keep going with the rest.
          appendError(outcome.error);
          updateBatchUpload(batchId, runId, {
            status: "failed",
            error: outcome.error,
          });
        }
        try {
          await persistBatchSnapshot();
        } catch {
          appendError(
            "Batch progress could not be saved, so the remaining uploads were stopped."
          );
          return;
        }
      }
      if (trimmedToSecs.length > 0) {
        setIngestInfo(
          `${trimmedToSecs.length} ${trimmedToSecs.length === 1 ? "clip" : "clips"} trimmed to ${trimmedToSecs[0].toFixed(1)}s — the video model accepts at most 10s.`
        );
      }
      if (assets.length === 0) return;
      setBudgetInput("");
      setLaunchError(null);
      setPendingBatchId(batchId);
    },
    [appendError, createBatchDraft, updateBatchUpload, workflowMode]
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!hydrated) {
        setIngestError("Wait for saved history to finish loading before uploading.");
        return;
      }
      if (readiness.phase !== "ready") {
        setIngestError(
          readiness.phase === "blocked"
            ? readiness.message
            : "Wait for the production readiness check to finish."
        );
        return;
      }
      if (ingesting || files.length === 0) return;
      setIngesting(true);
      setIngestError(null);
      setIngestInfo(null);
      try {
        const videos = files.filter((f) => {
          if (
            f.type.startsWith("video/") ||
            ((f.type === "" || f.type === "application/octet-stream") &&
              /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(f.name))
          ) {
            return true;
          }
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
    [appendError, handleMany, handleSingle, hydrated, ingesting, readiness]
  );

  const parsedBudget = useMemo(
    () => parseOptionalPositiveBudgetUsd(budgetInput),
    [budgetInput]
  );
  const workflowCopy = MODE_COPY[workflowMode];
  const workflowFlow = workflowMode === "lamp" ? LAMP_FLOW : FLORA_FLOW;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-8">
      <div className="grid items-end gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <header className="max-w-3xl">
          <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent">
            {workflowCopy.eyebrow}
          </span>
          <h1 className="mt-2 text-balance text-3xl font-semibold tracking-[-0.025em] text-ink sm:text-4xl">
            {workflowCopy.title}
          </h1>
          <p className="mt-3 max-w-2xl text-pretty text-sm leading-relaxed text-muted">
            {workflowCopy.description}
          </p>
        </header>
        <WorkflowModeSelector />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Selected product flow */}
        <Card className="p-5 lg:col-span-3">
          <SectionTitle
            right={
              <span className="text-2xs text-faint">
                {mode === "live" ? "real provider run" : "simulated demo"}
              </span>
            }
          >
            The {workflowModeLabel(workflowMode)} flow
          </SectionTitle>
          <ol className="grid gap-2 sm:grid-cols-2">
            {workflowFlow.map((step, index) => (
              <li
                key={step.title}
                className="rounded-xl bg-raised p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
              >
                <div className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold tabular-nums text-accent">
                    {index + 1}
                  </span>
                  <h2 className="text-balance text-sm font-medium text-ink">
                    {step.title}
                  </h2>
                </div>
                <p className="mt-2 text-pretty text-xs leading-relaxed text-muted">
                  {step.description}
                </p>
              </li>
            ))}
          </ol>
        </Card>

        {/* New single run or batch */}
        <Card className="p-5 lg:col-span-2">
          <SectionTitle>Choose videos</SectionTitle>
          <div
            role="button"
            tabIndex={0}
            aria-disabled={ingesting || !hydrated || readiness.phase !== "ready"}
            onClick={() => {
              if (!ingesting && hydrated && readiness.phase === "ready") {
                inputRef.current?.click();
              }
            }}
            onKeyDown={(e) => {
              if (
                (e.key === "Enter" || e.key === " ") &&
                !ingesting &&
                hydrated &&
                readiness.phase === "ready"
              ) {
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (hydrated && readiness.phase === "ready") setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!hydrated || readiness.phase !== "ready") return;
              void handleFiles(Array.from(e.dataTransfer.files));
            }}
            className={`flex min-h-48 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-center transition-[border-color,background-color,transform] duration-150 ease-out active:scale-[0.96] ${
              !hydrated || readiness.phase !== "ready"
                ? "cursor-not-allowed border-edge opacity-65"
                : dragging
                ? "border-accent bg-accent-soft"
                  : "cursor-pointer border-edge hover:border-faint"
            }`}
          >
            <p className="text-sm text-ink">
              {ingesting
                ? progress ?? "Reading your clip…"
                : !hydrated
                  ? "Loading saved history…"
                  : readiness.phase === "checking"
                  ? "Checking production readiness…"
                  : readiness.phase === "blocked"
                    ? "Uploads paused"
                    : "Drop one or more clips, or click to browse"}
            </p>
            <p className="max-w-xs text-pretty text-2xs text-faint">
              {mode === "live"
                ? `video/* · one clip starts a ${workflowModeLabel(workflowMode)} run · multiple clips start a live ${workflowModeLabel(workflowMode)} batch after cost review`
                : `video/* · one clip starts a demo run · multiple clips start a ${workflowModeLabel(workflowMode)} demo batch`}
            </p>
          </div>
          {ingestError ? (
            <p className="mt-2 text-2xs text-fail">{ingestError}</p>
          ) : null}
          {ingestInfo ? (
            <p className="mt-2 text-2xs text-borderline">{ingestInfo}</p>
          ) : null}
          {readiness.phase === "blocked" ? (
            <p className="mt-2 text-2xs leading-relaxed text-fail" role="alert">
              {readiness.message} No files have been sent.
            </p>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            multiple
            disabled={!hydrated || readiness.phase !== "ready"}
            className="hidden"
            onChange={(e) => {
              void handleFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <p className="mt-2 text-pretty text-2xs leading-relaxed text-faint">
            ~10s webcam clips work best · longer clips are auto-trimmed to the
            10s model cap · local media stays in data/; hosted media must use
            durable cloud storage
          </p>
        </Card>
      </div>

      {interruptedSingle ? (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Saved upload checkpoint</p>
            <p className="mt-0.5 truncate text-2xs text-faint">
              {interruptedSingle.fileName} was reserved before transfer. Completed
              bytes are recovered automatically; if the transfer stopped, choose
              that same file to continue under the saved run.
            </p>
          </div>
          <Button disabled={ingesting} onClick={() => inputRef.current?.click()}>
            Choose clip again
          </Button>
        </Card>
      ) : null}

      {!pendingLaunch
        ? resumableSingles.map((resumableSingle) => (
            <Card
              key={`resume-${resumableSingle.id}`}
              className="flex flex-wrap items-center gap-3 p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {resumableSingle.serverExecution?.status ===
                  "user_action_required"
                    ? `${workflowModeLabel(resumableSingle.workflowMode ?? "lamp")} is paused for approval`
                    : "Uploaded clip ready to generate"}
                </p>
                <p className="mt-0.5 truncate text-2xs text-faint">
                  {resumableSingle.serverExecution?.status ===
                  "user_action_required"
                    ? `${resumableSingle.originalVideo.label} is safely checkpointed. Renew the same exact two-pass approval to resume it without repeating completed provider work.`
                    : `${resumableSingle.originalVideo.label} is safely prepared. You can resume the spend confirmation without uploading it again.`}
                </p>
              </div>
              <Button
                disabled={launching === "run"}
                onClick={async () => {
                  setLaunchError(null);
                  const approvalResume =
                    resumableSingle.serverExecution?.status ===
                    "user_action_required";
                  if (mode === "mock" && !approvalResume) {
                    if (launching) return;
                    setLaunching("run");
                    try {
                      const id = await startRun(resumableSingle.originalVideo, {
                        workflowMode:
                          resumableSingle.workflowMode ?? workflowMode,
                      });
                      router.push(`/runs/${id}`);
                    } catch (error) {
                      appendError(
                        error instanceof Error
                          ? error.message
                          : "The saved run could not be resumed."
                      );
                    } finally {
                      setLaunching(null);
                    }
                    return;
                  }
                  setPendingLaunch({
                    video: resumableSingle.originalVideo,
                    trimNote: null,
                    workflowMode:
                      resumableSingle.workflowMode ?? workflowMode,
                  });
                }}
              >
                {resumableSingle.serverExecution?.status ===
                "user_action_required"
                  ? "Review and resume"
                  : mode === "live"
                    ? "Review and generate"
                    : "Resume run"}
              </Button>
            </Card>
          ))
        : null}

      {resumableBatch && pendingBatchId !== resumableBatch.id ? (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">
              {resumableBatch.status === "uploading"
                ? "Interrupted upload has clips ready"
                : "Uploaded batch ready to start"}
            </p>
            <p className="mt-0.5 text-2xs text-faint">
              {(resumableBatch.uploads ?? []).filter((item) => item.status === "ready").length}{" "}
              clips are safely prepared for {workflowModeLabel(resumableBatch.workflowMode ?? "flora")}
              {resumableBatch.status === "uploading"
                ? "; unfinished selections need to be chosen again later. You can start the ready clips now."
                : ". You can resume the spend confirmation without uploading them again."}
            </p>
          </div>
          <Button
            disabled={ingesting || launching === "batch"}
            onClick={() => {
              setBudgetInput("");
              setLaunchError(null);
              setPendingBatchId(resumableBatch.id);
            }}
          >
            {ingesting ? "Finishing uploads…" : "Review and start"}
          </Button>
        </Card>
      ) : null}

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
            hint={`Choose one clip above to start a ${workflowModeLabel(workflowMode)} run, or choose several for a batch.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="text-2xs uppercase tracking-[0.14em] text-faint">
                  <th className="px-4 pb-2 font-medium">Run</th>
                  <th className="px-4 pb-2 font-medium">Status</th>
                  <th className="px-4 pb-2 font-medium">Workflow stage</th>
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
                    passThreshold={workflow.config.compositePassThreshold}
                    inBatch={batchRunIds.has(run.id)}
                    readyToStart={
                      isResumableSingleRun(run, batchRunIds)
                    }
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
          title={`Run ${workflowModeLabel(pendingLaunch.workflowMode)} for this video?`}
          lines={
            pendingLaunch.workflowMode === "lamp"
              ? [
                  `${pendingLaunch.video.label} — ${pendingLaunch.video.durationSec.toFixed(1)}s`,
                  `Estimated provider cost: ${formatUsd(estimateLampRun(pendingLaunch.video.durationSec).totalUsd)}`,
                  `Spend authorization: the server reserves ${formatReservationUsd(workflowReservationUsd("lamp"))} for exactly two video generations and two holistic evaluation calls, including input and thinking usage plus the 50ms-per-generation container allowance. Actual cost is settled from provider usage; there is no open-ended retry loop.`,
                  "For both Initial and Final, Lamp restores and verifies source audio before the whole-video evaluation. The fixed two-pass run continues on the server if this tab closes.",
                  "Final enters per-video human grading. Its completed AI evaluation stays hidden by default and can be revealed whenever you choose.",
                  ...(pendingLaunch.trimNote ? [pendingLaunch.trimNote] : []),
                ]
              : [
                  `${pendingLaunch.video.label} — ${pendingLaunch.video.durationSec.toFixed(1)}s`,
                  `Estimated provider cost: ${formatUsd(estimateFirstCut(pendingLaunch.video.durationSec).totalUsd)}`,
                  `Spend authorization: the server reserves ${formatReservationUsd(workflowReservationUsd("flora"))} for one video generation, including input and thinking usage plus the 50ms container allowance. Actual cost is settled from provider usage.`,
                  "Flora restores and verifies the original audio, then sends the one-pass cut to human review.",
                  ...(pendingLaunch.trimNote ? [pendingLaunch.trimNote] : []),
                ]
          }
          confirmLabel={
            pendingLaunch.workflowMode === "lamp"
              ? "Generate Initial + Final"
              : "Generate Flora cut"
          }
          busy={launching === "run"}
          error={launchError}
          onConfirm={async () => {
            if (launching) return;
            setLaunching("run");
            setLaunchError(null);
            try {
              const id = await startRun(pendingLaunch.video, {
                approveLiveSpend: true,
                workflowMode: pendingLaunch.workflowMode,
              });
              setPendingLaunch(null);
              router.push(`/runs/${id}`);
            } catch (error) {
              setLaunchError(
                error instanceof Error
                  ? error.message
                  : "The run could not be saved before starting."
              );
            } finally {
              setLaunching(null);
            }
          }}
          onCancel={() => {
            setLaunchError(null);
            setPendingLaunch(null);
          }}
        />
      ) : null}

      {/* Both methods support provider-owned live batches and zero-spend demos. */}
      {pendingBatch && pendingBatchAssets.length > 0 ? (
        <ConfirmSpend
          title={`Start ${workflowModeLabel(pendingBatch.workflowMode ?? "flora")} batch of ${pendingBatchAssets.length} clips?`}
          lines={[
            `Total estimated provider cost: ${formatUsd(
              pendingBatchAssets.reduce(
                (sum, asset) =>
                  sum +
                  estimateWorkflowRun(
                    pendingBatch.workflowMode ?? "flora",
                    asset.durationSec
                  ).totalUsd,
                0
              )
            )}`,
            pendingBatch.workflowMode === "lamp"
              ? "Every Lamp clip uses exactly two generations and two holistic evaluations, then waits for its own human grade."
              : "Every Flora clip uses one generation and lands in the established human review queue.",
            mode === "live"
              ? `Batch spend authorization: the server reserves ${formatReservationUsd(
                  pendingBatchAssets.length *
                    workflowReservationUsd(
                      pendingBatch.workflowMode ?? "flora"
                    )
                )} total (${formatReservationUsd(
                  workflowReservationUsd(
                    pendingBatch.workflowMode ?? "flora"
                  )
                )} per clip), including input and thinking usage plus the bounded 50ms container allowance per generation. Actual cost is settled from provider usage. An optional budget cap can only reduce how many clips dispatch.`
              : "This is a demo batch; actual mock spend is $0.00.",
            mode === "mock"
              ? "The demo keeps the same bounded queue shape without calling a provider."
              : "The server owns the bounded live queue and preserves progress if this tab closes.",
            ...pendingBatchAssets.map(
              (asset) =>
                `${asset.label} — ${asset.durationSec.toFixed(1)}s · est. ${formatUsd(estimateWorkflowRun(pendingBatch.workflowMode ?? "flora", asset.durationSec).totalUsd)}`
            ),
          ]}
          confirmLabel={mode === "live" ? "Start live batch" : "Start demo batch"}
          busy={launching === "batch"}
          confirmDisabled={!parsedBudget.ok}
          error={parsedBudget.ok ? launchError : parsedBudget.error}
          onConfirm={async () => {
            if (launching) return;
            if (!parsedBudget.ok) {
              setLaunchError(parsedBudget.error);
              return;
            }
            setLaunching("batch");
            setLaunchError(null);
            try {
              const id = await startBatchFromDraft(pendingBatch.id, {
                budgetUsd: parsedBudget.value,
                approveLiveSpend: mode === "live",
                allowIncompleteUploads: pendingBatch.status === "uploading",
                workflowMode: pendingBatch.workflowMode ?? "flora",
              });
              if (id) {
                setPendingBatchId(null);
                router.push("/batch");
              }
            } catch (error) {
              setLaunchError(
                error instanceof Error
                  ? error.message
                  : "The batch could not be saved before starting."
              );
            } finally {
              setLaunching(null);
            }
          }}
          onCancel={() => {
            setLaunchError(null);
            setPendingBatchId(null);
          }}
        >
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Budget cap in USD (optional) — clips beyond the cap are skipped
            before dispatch
            <input
              type="number"
              min={0.01}
              step="0.01"
              inputMode="decimal"
              placeholder="no cap"
              value={budgetInput}
              onChange={(e) => {
                setBudgetInput(e.target.value);
                setLaunchError(null);
              }}
              className="min-h-10 rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
        </ConfirmSpend>
      ) : null}
    </div>
  );
}
