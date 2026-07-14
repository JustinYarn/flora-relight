import type { Metadata } from "next";
import { GradeView } from "@/components/grade/GradeView";

export const metadata: Metadata = {
  title: "Grade — Lamp",
  description:
    "Blind-grade final Lamp videos, then compare your calls with the available final AI evaluation",
};

/**
 * /grade — blind human grading with optional automated-result comparison.
 * Draft answers are durable server-side working memory; final grades are
 * stored atomically on the canonical run document.
 */
export default function GradePage() {
  return <GradeView />;
}
