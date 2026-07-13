import type { Metadata } from "next";
import { GradeView } from "@/components/grade/GradeView";

export const metadata: Metadata = {
  title: "Grade — Flora Relight",
  description:
    "Blind-grade the before/after cuts on the same 11 checks the AI judges use, then compare",
};

/**
 * /grade — human grading + AI calibration. Mode A grades clips BLIND (no AI
 * verdicts shown); mode B compares the saved grades against the shipped
 * attempt's eval results. All state lives client-side in GradeView.
 */
export default function GradePage() {
  return <GradeView />;
}
