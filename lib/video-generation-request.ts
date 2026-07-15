/**
 * Construct one source-based Omni generation request.
 *
 * Every iteration is deliberately independent. The correction brief belongs
 * in `prompt`; a previous provider interaction is never an input.
 */
export function buildFreshVideoGenerationRequest(input: {
  iteration: number;
  model: string;
  prompt: string;
  uploadUri: string;
}) {
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 1) {
    throw new Error("Video generation iteration must be a positive integer.");
  }
  return {
    model: input.model,
    input: [
      { type: "text" as const, text: input.prompt },
      {
        type: "video" as const,
        uri: input.uploadUri,
        mime_type: "video/mp4",
      },
    ],
    response_format: { type: "video" as const, delivery: "uri" as const },
    background: true,
    store: true,
  };
}
