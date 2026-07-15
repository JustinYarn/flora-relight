/**
 * Archive naming for provider-lost video generations. Kept out of
 * run-execution-resume.ts on purpose: that module is bundled into Workflow
 * orchestration code, where Node.js built-ins like node:crypto are
 * unavailable. Only HTTP routes and the storage layer need this.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic, id-charset-safe archive name for one lost interaction. The
 * digest keeps provider ids (which may use characters the journal id charset
 * forbids) out of the id while letting a retried acknowledgment find the
 * archive it already wrote.
 */
export function lostGenerationArchiveId(
  operationId: string,
  providerInteractionId: string
): string {
  const digest = createHash("sha256")
    .update(providerInteractionId, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${operationId}:lost:${digest}`;
}
