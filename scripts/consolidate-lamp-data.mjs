#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const MANAGED_ROOT_FILES = new Set([
  "index.json",
  "grade-drafts.json",
  "batches.json",
]);
const MANAGED_PREFIXES = [
  "runs/",
  "run-executions/",
  "batch-executions/",
  "uploads/",
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = { sources: [], apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      const value = argv[index + 1];
      if (!value) fail("--source requires a path.");
      result.sources.push(path.resolve(value));
      index += 1;
    } else if (arg === "--destination") {
      const value = argv[index + 1];
      if (!value) fail("--destination requires a path.");
      result.destination = path.resolve(value);
      index += 1;
    } else if (arg === "--backup-root") {
      const value = argv[index + 1];
      if (!value) fail("--backup-root requires a path.");
      result.backupRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--apply") {
      result.apply = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (result.sources.length < 2) fail("Pass at least two --source data roots.");
  if (!result.destination) fail("--destination is required.");
  if (result.sources.includes(result.destination)) {
    fail("The destination cannot also be a source.");
  }
  if (result.apply && !result.backupRoot) {
    fail("--backup-root is required with --apply.");
  }
  return result;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      fail(`Unsupported non-file entry in data root: ${path.join(root, child)}`);
    }
  }
  return files;
}

async function inventory(root) {
  const files = await listFiles(root);
  const records = [];
  for (const relative of files) {
    const fullPath = path.join(root, relative);
    const [info, sha256] = await Promise.all([stat(fullPath), sha256File(fullPath)]);
    records.push({ path: relative, bytes: info.size, sha256 });
  }
  return records;
}

function inventoryMap(records) {
  return new Map(records.map((record) => [record.path, record]));
}

function sameInventory(left, right) {
  if (left.length !== right.length) return false;
  const rightMap = inventoryMap(right);
  return left.every((record) => {
    const candidate = rightMap.get(record.path);
    return (
      candidate?.bytes === record.bytes && candidate.sha256 === record.sha256
    );
  });
}

async function readJson(filePath, fallback) {
  if (!(await exists(filePath))) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sourceLabel(root) {
  return path.basename(path.dirname(root));
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function mergeUniqueDocuments(collections, key, label) {
  const merged = new Map();
  for (const documents of collections) {
    for (const document of documents) {
      const id = document?.[key];
      if (typeof id !== "string" || id.length === 0) {
        fail(`${label} contains an entry without a valid ${key}.`);
      }
      const existing = merged.get(id);
      if (existing && canonicalJson(existing) !== canonicalJson(document)) {
        fail(`${label} collision for ${id} contains divergent JSON.`);
      }
      merged.set(id, document);
    }
  }
  return [...merged.values()];
}

function mergeGradeDrafts(documents) {
  const byId = new Map();
  for (const document of documents) {
    for (const [id, draft] of Object.entries(document)) {
      if (!draft || draft.id !== id || typeof draft.revision !== "number") {
        fail(`Grade draft ${id} is malformed.`);
      }
      const group = byId.get(id) ?? [];
      group.push(draft);
      byId.set(id, group);
    }
  }
  const merged = {};
  for (const [id, drafts] of byId) {
    const newest = [...drafts].sort(
      (a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision
    )[0];
    const clips = {};
    for (const draft of drafts) {
      for (const [runId, clip] of Object.entries(draft.clips ?? {})) {
        if (clips[runId] && canonicalJson(clips[runId]) !== canonicalJson(clip)) {
          fail(`Grade draft ${id} has divergent answers for ${runId}.`);
        }
        clips[runId] = clip;
      }
    }
    merged[id] = {
      id,
      revision: Math.max(...drafts.map((draft) => draft.revision)),
      updatedAt: Math.max(...drafts.map((draft) => draft.updatedAt)),
      clips,
      skippedRunIds: [
        ...new Set(drafts.flatMap((draft) => draft.skippedRunIds ?? [])),
      ],
      ...(newest.currentRunId ? { currentRunId: newest.currentRunId } : {}),
    };
  }
  return merged;
}

async function buildMergePlan(sources) {
  const sourceData = [];
  for (const root of sources) {
    const info = await stat(root);
    if (!info.isDirectory()) fail(`Source is not a directory: ${root}`);
    const files = await inventory(root);
    sourceData.push({
      root,
      label: sourceLabel(root),
      files,
      fileMap: inventoryMap(files),
      index: await readJson(path.join(root, "index.json"), []),
      batches: await readJson(path.join(root, "batches.json"), []),
      gradeDrafts: await readJson(path.join(root, "grade-drafts.json"), {}),
    });
  }
  if (new Set(sourceData.map((item) => item.label)).size !== sourceData.length) {
    fail("Source parent directory names must be unique for backup labeling.");
  }

  const index = mergeUniqueDocuments(
    sourceData.map((item) => item.index),
    "id",
    "Run index"
  ).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const batches = mergeUniqueDocuments(
    sourceData.map((item) => item.batches),
    "id",
    "Batch index"
  ).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const gradeDrafts = mergeGradeDrafts(
    sourceData.map((item) => item.gradeDrafts)
  );

  const copies = new Map();
  const identicalCollisions = [];
  for (const source of sourceData) {
    for (const record of source.files) {
      const relative = record.path;
      if (MANAGED_ROOT_FILES.has(relative)) continue;
      const managed = MANAGED_PREFIXES.some((prefix) => relative.startsWith(prefix));
      const key = relative;
      const existing = copies.get(key);
      if (!existing) {
        copies.set(key, { source: source.root, record, managed });
        continue;
      }
      if (
        existing.record.bytes !== record.bytes ||
        existing.record.sha256 !== record.sha256
      ) {
        fail(
          `Divergent file collision at ${relative} between ${sourceLabel(
            existing.source
          )} and ${source.label}.`
        );
      }
      identicalCollisions.push(relative);
    }
  }

  const indexedIds = new Set(index.map((run) => run.id));
  const runDirIds = new Set(
    [...copies.keys()]
      .map((relative) => /^runs\/([^/]+)\/run\.json$/.exec(relative)?.[1])
      .filter(Boolean)
  );
  for (const id of indexedIds) {
    if (!runDirIds.has(id)) fail(`Indexed run ${id} has no runs/${id}/run.json.`);
  }
  for (const id of runDirIds) {
    if (!indexedIds.has(id)) fail(`Run directory ${id} is absent from index.json.`);
  }

  return {
    sources: sourceData,
    index,
    batches,
    gradeDrafts,
    copies,
    identicalCollisions: [...new Set(identicalCollisions)].sort(),
  };
}

function collectMediaUrls(value, urls = new Set()) {
  if (typeof value === "string" && value.startsWith("/api/media/")) {
    urls.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, urls);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectMediaUrls(item, urls);
  }
  return urls;
}

async function validateDestination(root, plan) {
  const writtenIndex = await readJson(path.join(root, "index.json"), null);
  if (canonicalJson(writtenIndex) !== canonicalJson(plan.index)) {
    fail("Destination index.json does not match the merge plan.");
  }
  for (const entry of plan.index) {
    const runPath = path.join(root, "runs", entry.id, "run.json");
    const run = await readJson(runPath, null);
    if (!run || run.id !== entry.id) {
      fail(`Destination run document is missing or misbound: ${entry.id}.`);
    }
    for (const url of collectMediaUrls(run)) {
      const parsed = new URL(url, "http://local.invalid");
      const relative = decodeURIComponent(
        parsed.pathname.slice("/api/media/".length)
      );
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
        fail(`Run ${entry.id} contains an unsafe media URL: ${url}`);
      }
      if (!(await exists(path.join(root, relative)))) {
        fail(`Run ${entry.id} references missing media: ${url}`);
      }
    }
  }
  const executionDir = path.join(root, "run-executions");
  if (await exists(executionDir)) {
    for (const file of await readdir(executionDir)) {
      if (!file.endsWith(".json")) continue;
      const execution = await readJson(path.join(executionDir, file), null);
      if (!execution || !runDirIdsFromPlan(plan).has(execution.runId)) {
        fail(`Run execution ${file} does not bind to a migrated run directory.`);
      }
    }
  }
}

function runDirIdsFromPlan(plan) {
  return new Set(plan.index.map((entry) => entry.id));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function createVerifiedBackups(plan, backupRoot) {
  const snapshot = path.join(backupRoot, `lamp-data-${timestampSlug()}`);
  await mkdir(snapshot, { recursive: false });
  const manifest = { createdAt: new Date().toISOString(), sources: [] };
  for (const source of plan.sources) {
    const target = path.join(snapshot, source.label, "data");
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source.root, target, { recursive: true, errorOnExist: true });
    const copied = await inventory(target);
    if (!sameInventory(source.files, copied)) {
      fail(`Backup checksum verification failed for ${source.label}.`);
    }
    manifest.sources.push({
      label: source.label,
      sourcePath: source.root,
      fileCount: source.files.length,
      totalBytes: source.files.reduce((sum, file) => sum + file.bytes, 0),
      files: source.files,
    });
  }
  await writeJson(path.join(snapshot, "checksum-manifest.json"), manifest);
  return snapshot;
}

async function materialize(plan, destination) {
  if (await exists(destination)) {
    fail(`Destination already exists; refusing to overwrite it: ${destination}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(destination), ".data-unification-"));
  try {
    for (const [relative, copyPlan] of plan.copies) {
      const target = path.join(temporary, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(copyPlan.source, relative), target, {
        errorOnExist: true,
      });
    }
    await writeJson(path.join(temporary, "index.json"), plan.index);
    await writeJson(path.join(temporary, "batches.json"), plan.batches);
    await writeJson(path.join(temporary, "grade-drafts.json"), plan.gradeDrafts);
    await validateDestination(temporary, plan);
    await rename(temporary, destination);
  } catch (error) {
    error.message = `${error.message} Temporary merge retained at ${temporary}.`;
    throw error;
  }
}

function printSummary(plan, options) {
  const totalBytes = plan.sources.reduce(
    (sum, source) =>
      sum + source.files.reduce((fileSum, file) => fileSum + file.bytes, 0),
    0
  );
  const executionCount = [...plan.copies.keys()].filter((relative) =>
    /^run-executions\/[^/]+\.json$/.test(relative)
  ).length;
  console.log(
    JSON.stringify(
      {
        mode: options.apply ? "apply" : "dry-run",
        sources: plan.sources.map((source) => ({
          label: source.label,
          path: source.root,
          files: source.files.length,
          bytes: source.files.reduce((sum, file) => sum + file.bytes, 0),
        })),
        destination: options.destination,
        runs: plan.index.length,
        runExecutions: executionCount,
        batches: plan.batches.length,
        gradeDrafts: Object.keys(plan.gradeDrafts),
        identicalFileCollisions: plan.identicalCollisions,
        totalSourceBytes: totalBytes,
      },
      null,
      2
    )
  );
}

const options = parseArgs(process.argv.slice(2));
const plan = await buildMergePlan(options.sources);
printSummary(plan, options);
if (options.apply) {
  const backup = await createVerifiedBackups(plan, options.backupRoot);
  await materialize(plan, options.destination);
  console.log(`Verified backups: ${backup}`);
  console.log(`Atomic destination: ${options.destination}`);
} else {
  console.log("Dry run only. Re-run with --apply and --backup-root after review.");
}
