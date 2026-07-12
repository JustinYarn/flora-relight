import type { Metadata } from "next";
import { LibraryView } from "@/components/library/LibraryView";

export const metadata: Metadata = {
  title: "Library — Flora Relight",
  description: "Browse every past generation with progressive disclosure",
};

/**
 * /library — the reader over the on-disk run store: every past generation,
 * newest first, three levels of disclosure deep. All state lives client-side
 * in LibraryView (store + a freshness fetch of /api/runs).
 */
export default function LibraryPage() {
  return <LibraryView />;
}
