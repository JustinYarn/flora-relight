import type { Metadata } from "next";
import { GradeView } from "@/components/grade/GradeView";

export const metadata: Metadata = {
  title: "Grade — Lamp",
  description:
    "Grade final Lamp videos independently, with the saved AI evaluation hidden by default",
};

/**
 * /grade — human grading with an optional, explicit AI-evaluation reveal.
 * Draft answers are durable server-side working memory; final grades are
 * stored atomically on the canonical run document.
 */
export default async function GradePage({
  searchParams,
}: {
  searchParams: Promise<{
    run?: string | string[];
    candidate?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const requestedRunId =
    typeof params.run === "string" ? params.run : undefined;
  const requestedCombinedCandidateIteration =
    params.candidate === "1" || params.candidate === "2"
      ? (Number(params.candidate) as 1 | 2)
      : undefined;

  return (
    <GradeView
      requestedRunId={requestedRunId}
      requestedCombinedCandidateIteration={
        requestedCombinedCandidateIteration
      }
    />
  );
}
