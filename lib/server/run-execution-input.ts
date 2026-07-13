import "server-only";

import { createHash } from "node:crypto";

/** Exact prompt-byte binding shared by execution creation and paid start. */
export function runExecutionInputHash(renderedPrompt: string): string {
  return createHash("sha256").update(renderedPrompt, "utf8").digest("hex");
}
