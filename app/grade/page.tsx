import type { Metadata } from "next";
import { GradeView } from "@/components/grade/GradeView";

export const metadata: Metadata = {
  title: "Grade — Flora Relight",
  description:
    "Blind-grade relit before/after cuts across 11 quality checks and review saved results",
};

/**
 * /grade — blind human grading with optional automated-result comparison.
 * Draft answers are durable server-side working memory; final grades are
 * stored atomically on the canonical run document.
 */
export default function GradePage() {
  return <GradeView />;
}
