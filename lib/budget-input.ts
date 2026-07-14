export type OptionalBudgetParse =
  | { ok: true; value: number | undefined }
  | { ok: false; error: string };

/** Empty means uncapped; every non-empty value must be a positive USD cap. */
export function parseOptionalPositiveBudgetUsd(
  raw: string
): OptionalBudgetParse {
  if (raw.trim() === "") return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      error: "Budget cap must be a positive USD amount, or left empty for no cap.",
    };
  }
  return { ok: true, value };
}
