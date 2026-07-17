import type { Run } from "@/lib/types";

interface MergeGradeFeedOptions {
  /**
   * The exact server-owned objects observed when a complete list read began.
   * A missing record is removed only when it is still the same object, so an
   * older in-flight response cannot erase work created or updated meanwhile.
   */
  pruneMissingServerOwnedFrom?: ReadonlyMap<string, Run>;
}

function incomingExecutionIsOlder(local: Run, incoming: Run): boolean {
  const current = local.serverExecution;
  const next = incoming.serverExecution;
  if (!current || !next) return false;
  if (current.executionId === next.executionId) {
    return next.revision < current.revision;
  }
  return next.updatedAt < current.updatedAt;
}

function withNewestHumanGrade(base: Run, local: Run, incoming: Run): Run {
  const localAt = local.humanGrade?.gradedAt ?? -1;
  const incomingAt = incoming.humanGrade?.gradedAt ?? -1;
  const source = localAt > incomingAt ? local : incoming;
  const grade = source.humanGrade;
  if (!grade) return base;

  // The grade pairs with the DELIVERED take's evaluation: v2 everywhere
  // except a Lamp Iris best-of-two run whose settlement delivered the
  // Initial (serverExecution.deliveredIteration === 1).
  const deliveredIndex = base.serverExecution?.deliveredIteration ?? 2;
  const sourceFinal = source.iterations.find(
    (iteration) => iteration.index === deliveredIndex
  );
  let foundFinal = false;
  const iterations = base.iterations.map((iteration) => {
    if (iteration.index !== deliveredIndex || !sourceFinal) return iteration;
    foundFinal = true;
    if (sourceFinal.evalResults.length < iteration.evalResults.length) {
      return iteration;
    }
    return {
      ...iteration,
      evalResults: sourceFinal.evalResults,
      ...(sourceFinal.composite
        ? { composite: sourceFinal.composite }
        : { composite: undefined }),
    };
  });
  if (sourceFinal && !foundFinal) iterations.push(sourceFinal);
  iterations.sort((left, right) => left.index - right.index);

  return {
    ...base,
    humanGrade: grade,
    status: grade.shipIt ? "approved" : "needs-changes",
    iterations,
  };
}

/**
 * Reconcile the Grade page's browser cache with one authoritative server
 * listing. Server-owned executions accept monotonic server projections;
 * legacy/browser runs retain in-tab presentation state while gaining any
 * provider-journal-backed artifacts the server can verify.
 *
 * Unlike the original Grade refresh, this also appends runs that were created
 * by another tab/device or by a durable batch after the initial app hydrate.
 */
export function mergeGradeFeedRuns(
  localRuns: Run[],
  serverRuns: Run[],
  options: MergeGradeFeedOptions = {}
): Run[] {
  const serverById = new Map(serverRuns.map((run) => [run.id, run]));
  const retainedLocalRuns = localRuns.filter((run) => {
    const observed = options.pruneMissingServerOwnedFrom;
    if (
      observed === undefined ||
      !run.serverExecution ||
      serverById.has(run.id)
    ) {
      return true;
    }
    return observed.get(run.id) !== run;
  });
  const localIds = new Set(retainedLocalRuns.map((run) => run.id));

  const merged = retainedLocalRuns.map((local) => {
    const server = serverById.get(local.id);
    if (!server) return local;

    // Durable execution truth is wholly server-owned. Replacing the complete
    // projection also clears any stale locally cached trust marker if the
    // server has moved an artifact into reconciliation.
    if (server.serverExecution) {
      const base = incomingExecutionIsOlder(local, server) ? local : server;
      return withNewestHumanGrade(base, local, server);
    }

    const verifiedIterations = server.iterations.filter(
      (iteration) =>
        iteration.recoveredFromProviderOperation === true &&
        iteration.generatedVideo !== undefined
    );
    if (verifiedIterations.length === 0) {
      return withNewestHumanGrade(local, local, server);
    }

    const verifiedByIndex = new Map(
      verifiedIterations.map((iteration) => [iteration.index, iteration])
    );
    const localIndexes = new Set(
      local.iterations.map((iteration) => iteration.index)
    );
    const iterations = local.iterations.map((iteration) => {
      const verified = verifiedByIndex.get(iteration.index);
      return verified
        ? {
            ...iteration,
            interactionId: verified.interactionId,
            generatedVideo: verified.generatedVideo,
            recoveredFromProviderOperation: true as const,
          }
        : iteration;
    });
    for (const verified of verifiedIterations) {
      if (!localIndexes.has(verified.index)) iterations.push(verified);
    }
    iterations.sort((left, right) => left.index - right.index);
    const legacyMerged: Run = {
      ...local,
      originalVideo: server.originalVideo,
      providerOperations: server.providerOperations,
      iterations,
      finalVideo: local.finalVideo?.simulatedFilter
        ? local.finalVideo
        : undefined,
    };
    return withNewestHumanGrade(legacyMerged, local, server);
  });

  for (const server of serverRuns) {
    if (!localIds.has(server.id)) merged.push(server);
  }

  return merged.sort((left, right) => right.createdAt - left.createdAt);
}
