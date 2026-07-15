/**
 * Shared marker for a video generation whose provider interaction became
 * permanently unreadable upstream (Gemini rejects every interactions.get for
 * an id it issued). Client surfaces and the server recovery route must agree
 * on this exact prefix, so it lives outside lib/server.
 *
 * The charge outcome of a lost interaction is unknown: the journal entry that
 * carries this marker stays reconcile_required forever as billing evidence.
 * Recovery never edits it in place — it is archived under a superseded id and
 * a replacement generation requires a fresh explicit spend approval.
 */

export const PROVIDER_LOST_INTERACTION_MARKER =
  "The provider no longer recognizes this video generation interaction";

/** True when a journal/execution error string records a lost interaction. */
export function isProviderLostInteractionError(
  error: string | undefined
): boolean {
  return error?.startsWith(PROVIDER_LOST_INTERACTION_MARKER) === true;
}

/**
 * True for a journal entry archived under a superseded `:lost:` id. Archived
 * entries keep kind/iteration as billing evidence, so every kind+iteration
 * lookup that wants the CURRENT generation must exclude them — otherwise the
 * archive shadows the replacement generation in read models.
 */
export function isArchivedLostGenerationId(id: string): boolean {
  return id.includes(":lost:");
}
