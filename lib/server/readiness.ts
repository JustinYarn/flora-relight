/**
 * Server-owned production readiness.
 *
 * No AI provider is ever called. Local readiness stays side-effect free.
 * Hosted readiness actively earns `ready: true` with a small private-Blob and
 * Postgres write/read/delete round trip, cached briefly per server process.
 */

import { getFfmpegReadiness, type FfmpegReadiness } from "@/lib/server/ffmpeg";
import {
  getStorageConfiguration,
  getStorage,
  type DurableStorageVerification,
  type StorageConfiguration,
} from "@/lib/server/storage";

export type ReadinessStorageVerification =
  | { status: "not_required"; checkedAt: null; blob: null; database: null }
  | ({ status: "verified" | "failed" } & DurableStorageVerification);

export type ReadinessStorageStatus =
  | "ready"
  | "configuration_incomplete"
  | "durability_required"
  | "verification_failed";

export interface ReadinessDeployment {
  /** Vercel environment when hosted; otherwise the current Node environment. */
  environment: string;
  /** Vercel system Git metadata. Null when unavailable (for example, local development). */
  gitSha: string | null;
  gitRef: string | null;
}

export interface AppReadiness {
  schema: "flora.readiness.v1";
  generatedAt: string;
  /** Contextual readiness: local fs is valid locally; production requires durable storage. */
  ready: boolean;
  /** A permitted storage driver is completely configured for this runtime. */
  configured: boolean;
  /** Persistence survives a process/container restart. This describes the selected backend. */
  durable: boolean;
  /** The real ffmpeg discovery path successfully executed `ffmpeg -version`. */
  ffmpegReady: boolean;
  runtime: StorageConfiguration["runtime"];
  deployment: ReadinessDeployment;
  storage: Omit<Pick<
    StorageConfiguration,
    "driver" | "configured" | "durable" | "status" | "cloud" | "missing" | "verification"
  >, "verification"> & {
    /** Effective storage readiness after any required active verification. */
    ready: boolean;
    readinessStatus: ReadinessStorageStatus;
    /** Explicit name for the configuration-only status retained in `status`. */
    configurationStatus: StorageConfiguration["status"];
    verification: ReadinessStorageVerification;
  };
  ffmpeg: FfmpegReadiness;
}

const VERIFICATION_CACHE_MS = 60_000;
let verificationCache:
  | { expiresAt: number; value: DurableStorageVerification }
  | null = null;
let verificationInFlight: Promise<DurableStorageVerification> | null = null;

function safeDeploymentMetadata(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

async function verifyCloudStorage(): Promise<DurableStorageVerification> {
  const now = Date.now();
  if (verificationCache && verificationCache.expiresAt > now) {
    return verificationCache.value;
  }
  if (!verificationInFlight) {
    verificationInFlight = (async () => {
      const storage = getStorage();
      if (!storage.verifyDurableStorage) {
        return {
          ok: false,
          checkedAt: Date.now(),
          blob: { ok: false },
          database: { ok: false },
        };
      }
      return storage.verifyDurableStorage();
    })()
      .then((value) => {
        verificationCache = {
          // Cache failures briefly too, avoiding a health-check stampede while
          // still recovering quickly after infrastructure is repaired.
          expiresAt: Date.now() + VERIFICATION_CACHE_MS,
          value,
        };
        return value;
      })
      .finally(() => {
        verificationInFlight = null;
      });
  }
  return verificationInFlight;
}

export async function getAppReadiness(): Promise<AppReadiness> {
  const storage = getStorageConfiguration();
  const ffmpeg = await getFfmpegReadiness();
  let verification: ReadinessStorageVerification = {
    status: "not_required",
    checkedAt: null,
    blob: null,
    database: null,
  };
  if (storage.configured && storage.runtime.requiresDurable) {
    try {
      const result = await verifyCloudStorage();
      verification = {
        ...result,
        status: result.ok ? "verified" : "failed",
      };
    } catch {
      verification = {
        status: "failed",
        ok: false,
        checkedAt: Date.now(),
        blob: { ok: false },
        database: { ok: false },
      };
    }
  }
  const storageReady = storage.configured && (
    !storage.runtime.requiresDurable || (storage.durable && verification.status === "verified")
  );
  const storageReadinessStatus: ReadinessStorageStatus = storageReady
    ? "ready"
    : !storage.configured
      ? "configuration_incomplete"
      : storage.runtime.requiresDurable && !storage.durable
        ? "durability_required"
        : "verification_failed";

  return {
    schema: "flora.readiness.v1",
    generatedAt: new Date().toISOString(),
    ready: storageReady && ffmpeg.ready,
    configured: storage.configured,
    durable: storage.durable,
    ffmpegReady: ffmpeg.ready,
    runtime: storage.runtime,
    deployment: {
      environment: storage.runtime.environment,
      gitSha: safeDeploymentMetadata(process.env.VERCEL_GIT_COMMIT_SHA),
      gitRef: safeDeploymentMetadata(process.env.VERCEL_GIT_COMMIT_REF),
    },
    storage: {
      driver: storage.driver,
      configured: storage.configured,
      durable: storage.durable,
      ready: storageReady,
      readinessStatus: storageReadinessStatus,
      configurationStatus: storage.status,
      status: storage.status,
      cloud: storage.cloud,
      missing: storage.missing,
      verification,
    },
    ffmpeg,
  };
}
