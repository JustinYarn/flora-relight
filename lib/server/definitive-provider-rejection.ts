/**
 * Provider request failures that prove no model result was accepted.
 *
 * A synchronous Gemini 400 INVALID_ARGUMENT response is a definitive request
 * rejection. Gemini's exact 503 UNAVAILABLE capacity response is also safe to
 * replay: Google explicitly directs clients to retry it with backoff and no
 * model result or usage metadata accompanies the error. Other rate limits,
 * timeouts, 5xx responses, and parse/finalization errors deliberately do not
 * qualify here.
 */

interface GeminiErrorEnvelope {
  error?: {
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isDefinitiveGeminiRequestRejection(error: unknown): boolean {
  const message = errorMessage(error).trim();
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) return false;
  try {
    const envelope = JSON.parse(message.slice(jsonStart)) as GeminiErrorEnvelope;
    const hasMessage =
      typeof envelope.error?.message === "string" &&
      envelope.error.message.trim().length > 0;
    return Boolean(
      hasMessage &&
        ((envelope.error?.code === 400 &&
          envelope.error.status === "INVALID_ARGUMENT") ||
          (envelope.error?.code === 503 &&
            envelope.error.status === "UNAVAILABLE"))
    );
  } catch {
    return false;
  }
}

export function isRetryableGeminiCapacityError(error: unknown): boolean {
  const message = errorMessage(error).trim();
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) return false;
  try {
    const envelope = JSON.parse(message.slice(jsonStart)) as GeminiErrorEnvelope;
    return (
      envelope.error?.code === 503 &&
      envelope.error.status === "UNAVAILABLE" &&
      typeof envelope.error.message === "string" &&
      envelope.error.message.trim().length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Exact Combined-judge failures for which the provider returned no usable
 * artifact. Validation failures may already have consumed judge tokens, so a
 * replay still requires the normal renewed spend approval.
 */
export function isReplayableLampCombinedEvaluationFailure(
  error: unknown
): boolean {
  const message = errorMessage(error).trim();
  const deterministicOutputFailures = [
    "Lamp Combined holistic evaluator returned an invalid result envelope.",
    "Lamp Combined holistic evaluator returned an invalid result row.",
    "Lamp Combined holistic evaluator returned unexpected check ",
    "Lamp Combined holistic evaluator returned duplicate result ",
    "Lamp Combined holistic evaluator returned invalid result ",
    "Lamp Combined holistic evaluator omitted required checks: ",
  ];
  return (
    isDefinitiveGeminiRequestRejection(error) ||
    deterministicOutputFailures.some((prefix) => message.startsWith(prefix))
  );
}
