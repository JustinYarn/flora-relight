/**
 * lib/server/storage/index.ts — the single storage-selection policy.
 *
 * Local development may use <repo>/data through the fs driver. A production
 * or hosted runtime must have all durable-storage requirements configured:
 * private Vercel Blob for media, Postgres for run/batch state, and explicit
 * FLORA_BLOB_ACCESS=private intent. Production never falls back to its
 * ephemeral filesystem; getStorage() fails closed instead.
 *
 * Configuration inspection returns booleans and status labels only. Secret
 * values and database URLs never leave this server module.
 */

import { createBlobDriver } from "./blob-driver";
import { createFsDriver } from "./fs-driver";
import type { StorageDriver } from "./types";

export type {
  BatchAdvanceResult,
  DurableStorageVerification,
  GradeDraftDeleteResult,
  GradeDraftWriteResult,
  IngestFinalizationClaim,
  IngestUploadReservation,
  IngestUploadReserveResult,
  MediaRange,
  MediaStat,
  PaidOperationCostEntry,
  PaidOperationClaimResult,
  RunPage,
  RunPageCursor,
  StorageDriver,
} from "./types";
export { scratchMediaPath, scratchUploadsDir } from "./scratch";

let driver: StorageDriver | null = null;

export type StorageConfigurationStatus =
  | "local_fs"
  | "local_fs_partial_cloud_configuration"
  | "durable_configured_unverified"
  | "blob_access_not_private"
  | "incomplete_cloud_configuration"
  | "durable_storage_required";

export interface StorageConfiguration {
  /** Runtime facts used to choose the storage policy. */
  runtime: {
    environment: string;
    hosted: boolean;
    requiresDurable: boolean;
  };
  /** null means no driver is permitted and getStorage() will fail closed. */
  driver: "fs" | "blob" | null;
  /** A permitted driver is fully configured for this runtime. */
  configured: boolean;
  /** The selected driver persists outside the current process/container. */
  durable: boolean;
  status: StorageConfigurationStatus;
  /** Presence checks only; values are deliberately never returned. */
  cloud: {
    blobConfigured: boolean;
    databaseConfigured: boolean;
    /** Explicit operator intent; never inferred optimistically from a token. */
    blobAccess: "private" | "public" | "invalid" | "unspecified";
    privateAccessConfigured: boolean;
    complete: boolean;
  };
  /** Logical dependencies, never secret values. */
  missing: Array<"blob" | "database" | "private_blob_access">;
  /** Configuration inspection only; /api/readiness adds an active cloud probe. */
  verification: "not_checked";
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Pure policy resolver, exported so behavior can be regression-tested without
 * mutating process.env. Passing nothing inspects the current runtime.
 */
export function resolveStorageConfiguration(
  env: NodeJS.ProcessEnv = process.env
): StorageConfiguration {
  const blobConfigured = hasValue(env.BLOB_READ_WRITE_TOKEN);
  const databaseConfigured = hasValue(env.DATABASE_URL) || hasValue(env.POSTGRES_URL);
  const configuredAccess = env.FLORA_BLOB_ACCESS?.trim().toLowerCase();
  const blobAccess =
    configuredAccess === "private" || configuredAccess === "public"
      ? configuredAccess
      : configuredAccess
        ? "invalid"
        : "unspecified";
  const privateAccessConfigured = blobAccess === "private";
  const cloudComplete = blobConfigured && databaseConfigured && privateAccessConfigured;

  // VERCEL_ENV=development is also set by local `vercel dev`; that remains a
  // local-development runtime. Preview and production deployments are hosted.
  const hosted =
    env.VERCEL === "1" || env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "production";
  const requiresDurable = env.NODE_ENV === "production" || hosted;
  const environment = env.VERCEL_ENV ?? env.NODE_ENV ?? "development";
  const missing: Array<"blob" | "database" | "private_blob_access"> = [];
  if (!blobConfigured) missing.push("blob");
  if (!databaseConfigured) missing.push("database");
  if (!privateAccessConfigured) missing.push("private_blob_access");

  if (cloudComplete) {
    return {
      runtime: { environment, hosted, requiresDurable },
      driver: "blob",
      configured: true,
      durable: true,
      status: "durable_configured_unverified",
      cloud: {
        blobConfigured,
        databaseConfigured,
        blobAccess,
        privateAccessConfigured,
        complete: true,
      },
      missing: [],
      verification: "not_checked",
    };
  }

  if (requiresDurable) {
    return {
      runtime: { environment, hosted, requiresDurable },
      driver: null,
      configured: false,
      durable: false,
      status:
        blobConfigured && databaseConfigured && !privateAccessConfigured
          ? "blob_access_not_private"
          : blobConfigured || databaseConfigured
            ? "incomplete_cloud_configuration"
            : "durable_storage_required",
      cloud: {
        blobConfigured,
        databaseConfigured,
        blobAccess,
        privateAccessConfigured,
        complete: false,
      },
      missing,
      verification: "not_checked",
    };
  }

  // Local development remains byte-for-byte compatible with the original fs
  // path. A partial cloud setup is surfaced as a warning status rather than
  // breaking a developer who intentionally wants to keep working locally.
  return {
    runtime: { environment, hosted, requiresDurable },
    driver: "fs",
    configured: true,
    durable: false,
    status:
      blobConfigured || databaseConfigured
        ? "local_fs_partial_cloud_configuration"
        : "local_fs",
    cloud: {
      blobConfigured,
      databaseConfigured,
      blobAccess,
      privateAccessConfigured,
      complete: false,
    },
    missing,
    verification: "not_checked",
  };
}

export function getStorageConfiguration(): StorageConfiguration {
  return resolveStorageConfiguration(process.env);
}

export class StorageConfigurationError extends Error {
  readonly code = "STORAGE_NOT_CONFIGURED";
  readonly configuration: StorageConfiguration;

  constructor(configuration: StorageConfiguration) {
    const message =
      configuration.status === "blob_access_not_private"
        ? "Hosted media requires a private Blob store. Set FLORA_BLOB_ACCESS=private only after connecting a private store."
        : configuration.status === "incomplete_cloud_configuration"
        ? "Cloud storage configuration is incomplete. Configure both Blob and database storage."
        : "Durable storage is required in production. Configure private Blob and database storage.";
    super(message);
    this.name = "StorageConfigurationError";
    this.configuration = configuration;
  }
}

export function getStorage(): StorageDriver {
  if (!driver) {
    const configuration = getStorageConfiguration();
    if (!configuration.configured || !configuration.driver) {
      throw new StorageConfigurationError(configuration);
    }

    const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
    if (configuration.driver === "blob") {
      // The pure resolver already proved this exists. Keep the guard local so
      // a test/runtime that mutates process.env between calls still fails safe.
      if (!databaseUrl) throw new StorageConfigurationError(configuration);
      driver = createBlobDriver(databaseUrl);
    } else {
      driver = createFsDriver();
    }

    console.log(
      `[storage] driver: ${driver.name}` +
        (driver.name === "fs"
          ? " (local <repo>/data)"
          : " (private Vercel Blob + Neon Postgres)")
    );
  }
  return driver;
}
