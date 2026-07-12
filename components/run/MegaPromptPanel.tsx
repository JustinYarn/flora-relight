"use client";

import { useState } from "react";
import type { MegaPrompt, ViolationSeverity } from "@/lib/types";
import { Badge, Card } from "@/components/ui";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";

function severityColor(s: ViolationSeverity): string {
  return s === "critical" ? "var(--fail)" : s === "major" ? "var(--borderline)" : "var(--muted)";
}

function evalName(id: string): string {
  return EVAL_DEFS.find((d) => d.id === id)?.name ?? id;
}

/**
 * Collapsible view of the mega prompt for the selected iteration: the
 * corrections ledger (structured deltas, not accumulated prose), the diff
 * versus the previous iteration's prompt, and the fully rendered text that
 * was sent to the video model.
 */
export function MegaPromptPanel({
  megaPrompt,
  prev,
}: {
  megaPrompt?: MegaPrompt;
  prev?: MegaPrompt;
}) {
  const [open, setOpen] = useState(false);
  if (!megaPrompt) return null;

  const activeCount = megaPrompt.corrections.filter((c) => !c.resolved).length;
  const newCorrections = megaPrompt.corrections.filter(
    (c) => !prev || !prev.corrections.some((p) => p.id === c.id)
  );
  const newlyResolved = megaPrompt.corrections.filter(
    (c) => c.resolved && prev?.corrections.some((p) => p.id === c.id && !p.resolved)
  );

  return (
    <Card>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex flex-wrap items-center gap-3">
          <span className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
            Mega prompt
          </span>
          <Badge color="var(--accent)">v{megaPrompt.version}</Badge>
          <span className="text-2xs text-faint">
            {activeCount} active correction{activeCount === 1 ? "" : "s"} ·{" "}
            {megaPrompt.corrections.length} total in ledger
          </span>
        </span>
        <span className="text-faint">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-edge px-4 pb-4 pt-3">
          {/* Changes vs previous iteration */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-2xs">
              <span className="uppercase tracking-wider text-faint">vs previous iteration</span>
              {prev ? (
                <>
                  <Badge color="var(--running)">+{newCorrections.length} new</Badge>
                  <Badge color="var(--pass)">{newlyResolved.length} newly resolved</Badge>
                </>
              ) : (
                <span className="text-faint">first iteration — base prompt + lighting directive only</span>
              )}
            </div>
            {prev && newCorrections.length > 0 ? (
              <ul className="space-y-0.5 text-2xs text-muted">
                {newCorrections.map((c) => (
                  <li key={c.id}>+ {c.instruction}</li>
                ))}
              </ul>
            ) : null}
            {prev && newlyResolved.length > 0 ? (
              <ul className="space-y-0.5 text-2xs text-faint">
                {newlyResolved.map((c) => (
                  <li key={c.id} className="line-through">
                    {c.instruction}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {/* Corrections ledger */}
          {megaPrompt.corrections.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-2xs">
                <thead>
                  <tr className="border-b border-edge text-left uppercase tracking-wider text-faint">
                    <th className="py-1.5 pr-3 font-medium">Severity</th>
                    <th className="py-1.5 pr-3 font-medium">Instruction</th>
                    <th className="py-1.5 pr-3 font-medium">Source eval</th>
                    <th className="py-1.5 pr-3 font-medium">Added</th>
                    <th className="py-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {megaPrompt.corrections.map((c) => (
                    <tr key={c.id} className="border-b border-edge align-top last:border-0">
                      <td className="py-2 pr-3">
                        <Badge color={severityColor(c.severity)}>{c.severity}</Badge>
                      </td>
                      <td
                        className={`py-2 pr-3 ${
                          c.resolved ? "text-faint line-through" : "text-ink"
                        }`}
                      >
                        {c.instruction}
                      </td>
                      <td className="py-2 pr-3 text-muted">{evalName(c.sourceEvalId)}</td>
                      <td className="py-2 pr-3 tabular-nums text-muted">iter {c.addedAtIteration}</td>
                      <td className="py-2">
                        {c.resolved ? (
                          <Badge color="var(--pass)">resolved</Badge>
                        ) : (
                          <Badge color="var(--borderline)">active</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-2xs text-faint">
              No corrections yet — the ledger fills as evals report violations.
            </p>
          )}

          {/* Rendered prompt */}
          <div>
            <p className="mb-1.5 text-2xs uppercase tracking-wider text-faint">
              Rendered prompt (as sent to the video model — resolved corrections dropped)
            </p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-canvas p-3 font-mono text-2xs leading-relaxed text-muted">
              {megaPrompt.rendered}
            </pre>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
