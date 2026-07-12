"use client";

import type { FrameSample, Iteration } from "@/lib/types";
import { Card, SectionTitle } from "@/components/ui";
import { formatTime } from "@/lib/util";

function Thumb({ frame, alt }: { frame?: FrameSample; alt: string }) {
  if (!frame?.dataUrl) {
    return <div className="aspect-video w-full animate-pulse rounded-md bg-raised" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- data URLs from canvas extraction
    <img
      src={frame.dataUrl}
      alt={alt}
      className="aspect-video w-full rounded-md border border-edge object-cover"
    />
  );
}

/**
 * The exact frames the judges saw: one column per sampled timestamp, original
 * on top, relit below. Skeleton boxes until extraction lands.
 */
export function FramesStrip({ iteration }: { iteration?: Iteration }) {
  if (!iteration) return null;

  const pairs = iteration.beforeFrames.map((before, i) => ({
    before,
    after:
      iteration.afterFrames.find((f) => f.timestampSec === before.timestampSec) ??
      iteration.afterFrames[i],
  }));

  return (
    <section>
      <SectionTitle
        right={
          <span className="text-2xs text-faint">
            top: original · bottom: relit v{iteration.index}
          </span>
        }
      >
        Judged frames
      </SectionTitle>
      <Card className="p-3.5">
        {pairs.length > 0 ? (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {pairs.map(({ before, after }) => (
              <figure key={before.timestampSec} className="flex w-32 shrink-0 flex-col gap-1.5">
                <Thumb frame={before} alt={`original @ ${formatTime(before.timestampSec)}`} />
                <Thumb frame={after} alt={`relit @ ${formatTime(before.timestampSec)}`} />
                <figcaption className="text-center text-2xs tabular-nums text-faint">
                  {formatTime(before.timestampSec)}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="text-2xs text-faint">Extracting frames…</p>
        )}
      </Card>
    </section>
  );
}
