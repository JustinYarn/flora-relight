"use client";

import { useEffect, useRef, useState } from "react";
import type { RunLogEntry } from "@/lib/types";
import { Card } from "@/components/ui";
import { formatClock } from "@/lib/util";

const LEVEL_COLOR: Record<RunLogEntry["level"], string> = {
  info: "var(--muted)",
  warn: "var(--borderline)",
  error: "var(--fail)",
};

/** Collapsible monospace log; follows the tail while the run is executing. */
export function RunLog({ log, running }: { log: RunLogEntry[]; running: boolean }) {
  const [open, setOpen] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** True while the reader is at (or near) the tail; scrolling up unsticks. */
  const stick = useRef(true);

  useEffect(() => {
    if (running && open && stick.current && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [log.length, running, open]);

  return (
    <Card>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-3">
          <span className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            Run log
          </span>
          <span className="text-2xs tabular-nums text-faint">{log.length} entries</span>
          {running ? <span className="text-2xs text-running">live</span> : null}
        </span>
        <span className="text-faint">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="max-h-56 overflow-y-auto border-t border-edge px-4 py-2 font-mono text-2xs leading-relaxed"
        >
          {log.length > 0 ? (
            log.map((e, i) => (
              <div key={i} className="flex items-baseline gap-2 py-px">
                <span className="shrink-0 tabular-nums text-faint">{formatClock(e.at)}</span>
                {e.nodeId ? <span className="shrink-0 text-accent">[{e.nodeId}]</span> : null}
                <span style={{ color: LEVEL_COLOR[e.level] }}>{e.message}</span>
              </div>
            ))
          ) : (
            <p className="py-1 text-faint">No log entries yet.</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}
