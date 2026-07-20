import { createHash } from "node:crypto";

/** Stable, id-safe archive name for one definitively rejected paid request. */
export function rejectedPaidOperationArchiveId(
  operationId: string,
  inputHash: string,
  startedAt: number
): string {
  const digest = createHash("sha256")
    .update(`${operationId}:${inputHash}:${startedAt}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${operationId}:rejected:${digest}`;
}
