let counter = 0;

/** Short unique id, stable enough for client-side entities. */
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function formatTime(sec: number): string {
  // Round to display precision BEFORE splitting minutes/seconds so 59.97s
  // renders "1:00.0", not "0:60.0" (carry must happen before the split).
  const total = Math.round(sec * 10) / 10;
  const m = Math.floor(total / 60);
  const s = (total - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

export const LOW_CONFIDENCE = 0.4; // judge-disagreement threshold: below this an eval is flagged for human review (UI badge + engine demotion use the same constant)

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 0-100 score → verdict given a definition's thresholds. */
export function verdictFor(
  score: number,
  passThreshold: number,
  borderlineThreshold: number
): "pass" | "borderline" | "fail" {
  if (score >= passThreshold) return "pass";
  if (score >= borderlineThreshold) return "borderline";
  return "fail";
}
