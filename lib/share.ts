import type { EvalResult, Iteration, Run, RunStatus, Verdict } from "@/lib/types";
import { EVAL_DEFS } from "@/lib/prompts/eval-defs";
import { LOW_CONFIDENCE } from "@/lib/util";

/**
 * buildShareSnapshot(run) — compiles one run into a single, fully
 * self-contained HTML file a reviewer can open anywhere: no server, no
 * tracking, no dependencies. The file is the product.
 *
 * Contents mirror the Review page contract: clip header, original vs relit
 * side by side, the verdict line, and the 11 eval rows — plus a pure
 * client-side feedback affordance (agree/disagree per eval + a note) whose
 * output is a plain-text summary copied to the clipboard, so teammates can
 * judge whether the evaluations match their expectations of the video and
 * paste their read back into chat.
 *
 * MOCK MODE NOTE: today the "relit" side is a second <video> playing the SAME
 * embedded source with the winning iteration's CSS simulatedFilter applied —
 * exactly how the app itself simulates generation.
 * TODO(real-generation): when real video generation lands, embed the actual
 * generated file as a second data URI here (and drop the CSS filter path).
 */

/** Hardcoded copies of the app's dark tokens (globals.css) — the snapshot must render standalone. */
const T = {
  canvas: "#0b0d10",
  surface: "#12151a",
  raised: "#1a1e25",
  edge: "#262c36",
  ink: "#e8eaee",
  muted: "#98a1ad",
  faint: "#5c6570",
  accent: "#8b7cf6",
  pass: "#34d399",
  borderline: "#fbbf24",
  fail: "#f87171",
} as const;

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "running",
  "awaiting-review": "awaiting review",
  approved: "approved",
  "needs-changes": "needs changes",
  failed: "failed",
};

const STATUS_COLOR: Record<RunStatus, string> = {
  running: "#60a5fa",
  "awaiting-review": T.borderline,
  approved: T.pass,
  "needs-changes": T.fail,
  failed: T.fail,
};

const VERDICT_COLOR: Record<Verdict, string> = {
  pass: T.pass,
  borderline: T.borderline,
  fail: T.fail,
};

/** Embedding cap: a data URI inflates bytes ~4/3, and reviewers mail these files around. */
const MAX_EMBED_BYTES = 40 * 1024 * 1024;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Same resolution the Review page uses: bestIterationIndex is a 1-based Iteration.index, with fallbacks. */
function winningIteration(run: Run): Iteration | undefined {
  const last = run.iterations[run.iterations.length - 1];
  const bi = run.bestIterationIndex;
  if (bi === undefined) return last;
  return run.iterations.find((it) => it.index === bi) ?? run.iterations[bi] ?? last;
}

/**
 * Fetch the run's video and inline it as a base64 data URI. Works for both
 * /samples public paths and same-session object URLs (uploads). Object URLs
 * from a PREVIOUS session are dead — surface that as a friendly error.
 */
async function videoToDataUri(url: string): Promise<string> {
  let blob: Blob;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch {
    throw new Error(
      "Couldn't read the clip for embedding — uploaded clips only live in the session that created them. Re-run the clip, then share again."
    );
  }
  if (blob.size > MAX_EMBED_BYTES) {
    const mb = Math.round(blob.size / (1024 * 1024));
    throw new Error(
      `This clip is ~${mb} MB — too large to embed in a self-contained snapshot (limit ~40 MB). Trim the clip or share a shorter take.`
    );
  }
  // Object-URL blobs occasionally arrive untyped; a <video> needs a mime.
  const typed = blob.type ? blob : new Blob([blob], { type: "video/mp4" });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(new Error("Couldn't encode the clip for embedding — try again."));
    reader.readAsDataURL(typed);
  });
}

function chip(text: string, color: string): string {
  return `<span class="chip" style="color:${color};border-color:${color}44;background:${color}1a">${esc(text)}</span>`;
}

function violationsBlock(result: EvalResult): string {
  if (result.violations.length === 0) return "";
  const items = result.violations
    .map(
      (v) =>
        `<li><span class="sev sev-${v.severity}">${esc(v.severity)}</span> <strong>${esc(
          v.aspect
        )}</strong> — ${esc(v.description)}${
          v.correction ? `<div class="fix">fix: ${esc(v.correction)}</div>` : ""
        }</li>`
    )
    .join("");
  const n = result.violations.length;
  return `<details><summary>${n} violation${n === 1 ? "" : "s"}</summary><ul>${items}</ul></details>`;
}

interface EvalLineData {
  name: string;
  line: string;
}

function evalRow(
  idx: number,
  def: (typeof EVAL_DEFS)[number],
  result: EvalResult | undefined
): { html: string; data: EvalLineData } {
  const sub = `${def.category}${def.hardGate ? " · hard gate" : ""}`;
  if (!result) {
    return {
      html: `<div class="row" data-idx="${idx}">
  <div class="row-main">
    <div class="row-name"><div class="name">${esc(def.name)}</div><div class="cat">${esc(sub)}</div></div>
    <div class="score" style="color:${T.faint}">—</div>
    <div class="conf">&nbsp;</div>
    ${chip("NOT RUN", T.faint)}
  </div>
  ${feedbackControls()}
</div>`,
      data: { name: def.name, line: "not run" },
    };
  }
  const color = VERDICT_COLOR[result.verdict];
  const score = Math.round(result.score);
  const conf = Math.round(result.confidence * 100);
  const lowConf = result.confidence < LOW_CONFIDENCE;
  return {
    html: `<div class="row" data-idx="${idx}">
  <div class="row-main">
    <div class="row-name"><div class="name">${esc(def.name)}</div><div class="cat">${esc(sub)}</div></div>
    <div class="score" style="color:${color}">${score}<span class="pct">%</span></div>
    <div class="conf${lowConf ? " conf-low" : ""}" title="judge agreement">conf ${conf}%${lowConf ? " · low" : ""}</div>
    ${chip(result.verdict.toUpperCase(), color)}
  </div>
  ${violationsBlock(result)}
  ${feedbackControls()}
</div>`,
    data: {
      name: def.name,
      line: `${result.verdict.toUpperCase()} ${score}% (confidence ${conf}%)`,
    },
  };
}

/** Per-row team-feedback affordance: agree/disagree toggles + a free-text note. Pure client-side. */
function feedbackControls(): string {
  return `<div class="fb">
    <span class="fb-label">your read</span>
    <button type="button" class="fb-btn fb-agree">agree</button>
    <button type="button" class="fb-btn fb-disagree">disagree</button>
    <input class="fb-note" type="text" placeholder="note (optional)" />
  </div>`;
}

export async function buildShareSnapshot(run: Run): Promise<string> {
  const winner = winningIteration(run);
  const composite = winner?.composite;
  const attempts = run.iterations.length;
  const dataUri = await videoToDataUri(run.originalVideo.url);

  // Mock-mode comparison: the relit side replays the same embedded source
  // through the winning iteration's CSS filter, exactly like the app does.
  // TODO(real-generation): embed the real generated video as a second source.
  const relitFilter =
    run.finalVideo?.simulatedFilter ??
    winner?.generatedVideo?.simulatedFilter ??
    "";

  const startedAt = new Date(run.createdAt).toLocaleString();
  const generatedAt = new Date().toLocaleString();
  const statusLabel = STATUS_LABEL[run.status];
  const statusColor = STATUS_COLOR[run.status];

  const resultByEvalId = new Map<string, EvalResult>(
    (winner?.evalResults ?? []).map((r) => [r.evalId, r])
  );
  const rows = EVAL_DEFS.map((def, i) => evalRow(i, def, resultByEvalId.get(def.id)));

  const compositeColor = composite
    ? composite.passed
      ? T.pass
      : T.fail
    : T.faint;
  const compositeScore = composite ? String(Math.round(composite.score)) : "—";
  const verdictBits: string[] = [];
  verdictBits.push(composite ? (composite.passed ? "PASSED" : "DID NOT PASS") : "no completed iteration yet");
  verdictBits.push(`${attempts} attempt${attempts === 1 ? "" : "s"}`);
  if (run.bestIterationIndex !== undefined) {
    verdictBits.push(`best: iteration ${run.bestIterationIndex}`);
  }
  const gateFailures = composite?.hardGateFailures ?? [];
  const gateLine =
    gateFailures.length > 0
      ? `<p class="gate-warn">hard gate${gateFailures.length === 1 ? "" : "s"} failed: ${esc(gateFailures.join(", "))}</p>`
      : "";
  const fallbackLine = run.fallback?.applied
    ? `<p class="gate-warn">FALLBACK APPLIED — color transfer onto original pixels: ${esc(run.fallback.reason)}</p>`
    : "";

  const summaryData = {
    clip: run.originalVideo.label,
    runId: run.id,
    status: statusLabel,
    compositeLine: composite
      ? `Composite: ${Math.round(composite.score)}/100 — ${composite.passed ? "PASSED" : "DID NOT PASS"} · ${attempts} attempt${attempts === 1 ? "" : "s"}${run.bestIterationIndex !== undefined ? ` · best iteration ${run.bestIterationIndex}` : ""}`
      : `Composite: — (no completed iteration yet) · ${attempts} attempt${attempts === 1 ? "" : "s"}`,
    fallbackLine: run.fallback?.applied
      ? `FALLBACK APPLIED — color transfer onto original pixels: ${run.fallback.reason}`
      : "",
    evals: rows.map((r) => r.data),
    footer: `Generated by Flora Relight · mock simulation · ${generatedAt}`,
  };
  // "<" escaped so a note/label can never terminate the <script> block early.
  const summaryJson = JSON.stringify(summaryData).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Relight review — ${esc(run.originalVideo.label)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${T.canvas}; color: ${T.ink}; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 40px 24px 110px; }
  .wrap { max-width: 920px; margin: 0 auto; }
  .label { font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: ${T.muted}; }
  header h1 { font-size: 19px; font-weight: 600; }
  header .meta { margin-top: 6px; font-size: 12px; color: ${T.faint}; }
  .chip { display: inline-block; border: 1px solid; border-radius: 999px; padding: 1px 9px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; white-space: nowrap; }
  .status-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  section { margin-top: 44px; }
  .videos { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 700px) { .videos { grid-template-columns: 1fr; } }
  .videos figure figcaption { margin-bottom: 8px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .videos .note { font-size: 11px; color: ${T.faint}; letter-spacing: 0; text-transform: none; font-weight: 400; }
  .videos video { width: 100%; display: block; border: 1px solid ${T.edge}; border-radius: 12px; background: #000; }
  .play-row { margin-top: 14px; text-align: center; }
  #play-both { background: transparent; color: ${T.muted}; border: 1px solid ${T.edge}; border-radius: 8px; padding: 7px 18px; font-size: 13px; cursor: pointer; }
  #play-both:hover { color: ${T.ink}; border-color: ${T.faint}; }
  .verdict { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-top: 12px; }
  .verdict .big { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .verdict .big .of { font-size: 15px; font-weight: 400; color: ${T.faint}; }
  .verdict .detail { font-size: 13px; color: ${T.muted}; }
  .gate-warn { margin-top: 10px; font-size: 12px; color: ${T.borderline}; }
  .rows { margin-top: 10px; }
  .row { border-top: 1px solid ${T.edge}; padding: 18px 0; }
  .row-main { display: flex; align-items: center; gap: 16px; }
  .row-name { flex: 1; min-width: 0; }
  .row-name .name { font-size: 14px; }
  .row-name .cat { font-size: 11px; color: ${T.faint}; margin-top: 1px; }
  .score { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 74px; text-align: right; }
  .score .pct { font-size: 13px; font-weight: 400; opacity: 0.7; }
  .conf { font-size: 12px; color: ${T.muted}; font-variant-numeric: tabular-nums; min-width: 108px; }
  .conf-low { color: ${T.borderline}; }
  details { margin-top: 10px; font-size: 12px; color: ${T.muted}; }
  details summary { cursor: pointer; color: ${T.faint}; }
  details ul { margin: 8px 0 0 18px; display: grid; gap: 6px; }
  details .fix { color: ${T.faint}; margin-top: 2px; }
  .sev { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-right: 4px; }
  .sev-critical { color: ${T.fail}; }
  .sev-major { color: ${T.borderline}; }
  .sev-minor { color: ${T.faint}; }
  .fb { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .fb-label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: ${T.faint}; }
  .fb-btn { background: transparent; border: 1px solid ${T.edge}; border-radius: 999px; color: ${T.muted}; font-size: 11px; padding: 2px 11px; cursor: pointer; }
  .fb-btn:hover { border-color: ${T.faint}; color: ${T.ink}; }
  .fb-agree.on { color: ${T.pass}; border-color: ${T.pass}66; background: ${T.pass}1a; }
  .fb-disagree.on { color: ${T.fail}; border-color: ${T.fail}66; background: ${T.fail}1a; }
  .fb-note { flex: 1; min-width: 120px; background: transparent; border: none; border-bottom: 1px solid ${T.edge}; color: ${T.ink}; font-size: 12px; padding: 3px 2px; outline: none; }
  .fb-note:focus { border-bottom-color: ${T.faint}; }
  .fb-note::placeholder { color: ${T.faint}; }
  footer { margin-top: 48px; text-align: center; font-size: 11px; color: ${T.faint}; }
  .bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; background: ${T.surface}; border-top: 1px solid ${T.edge}; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .bottom-bar .hint { font-size: 12px; color: ${T.faint}; }
  #copy-feedback { background: ${T.accent}; color: ${T.canvas}; border: none; border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  #copy-feedback:hover { filter: brightness(1.1); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="status-line">
      <h1>${esc(run.originalVideo.label)}</h1>
      ${chip(statusLabel, statusColor)}
    </div>
    <p class="meta">run ${esc(run.id)} · started ${esc(startedAt)}</p>
  </header>

  <section>
    <div class="videos">
      <figure>
        <figcaption><span class="label">Original</span></figcaption>
        <video id="v-orig" src="${dataUri}" playsinline loop preload="metadata"></video>
      </figure>
      <figure>
        <figcaption><span class="label">Relit</span><span class="note">simulated preview — mock mode</span></figcaption>
        <!-- TODO(real-generation): replace this filtered copy of the original with the real generated video embedded as its own data URI. -->
        <video id="v-relit" src="${dataUri}" style="filter:${esc(relitFilter)}" playsinline loop muted preload="metadata"></video>
      </figure>
    </div>
    <div class="play-row"><button type="button" id="play-both">Play both</button></div>
  </section>

  <section>
    <span class="label">Verdict</span>
    <div class="verdict">
      <span class="big" style="color:${compositeColor}">${compositeScore}<span class="of">/100</span></span>
      <span class="detail">${esc(verdictBits.join(" · "))}</span>
    </div>
    ${gateLine}
    ${fallbackLine}
  </section>

  <section>
    <span class="label">Evals — do these match your read of the video?</span>
    <div class="rows">
${rows.map((r) => r.html).join("\n")}
    </div>
  </section>

  <footer>Generated by Flora Relight · mock simulation · ${esc(generatedAt)}</footer>
</div>

<div class="bottom-bar">
  <span class="hint">Mark agree/disagree per eval, add notes, then copy the summary and paste it back to the team.</span>
  <button type="button" id="copy-feedback">Copy feedback summary</button>
</div>

<script type="application/json" id="snapshot-data">${summaryJson}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('snapshot-data').textContent);

  // Shared play button: keeps the two copies of the clip in lockstep.
  var a = document.getElementById('v-orig');
  var b = document.getElementById('v-relit');
  var playBtn = document.getElementById('play-both');
  function tryPlay(v) {
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* autoplay/power-save aborts are non-fatal */ });
  }
  playBtn.addEventListener('click', function () {
    if (a.paused) {
      b.currentTime = a.currentTime;
      tryPlay(a);
      tryPlay(b);
    } else {
      a.pause();
      b.pause();
    }
  });
  a.addEventListener('play', function () { playBtn.textContent = 'Pause'; });
  a.addEventListener('pause', function () { playBtn.textContent = 'Play both'; b.pause(); });
  a.addEventListener('seeked', function () { b.currentTime = a.currentTime; });
  // Keep the pair in lockstep. Browsers may pause a muted video on their own
  // (power saving), so resync + resume from the original's timeupdate — it
  // fires only while the original plays, so retries are bounded in rate and
  // stop entirely on user pause.
  b.addEventListener('pause', function () {
    if (!a.paused) b.currentTime = a.currentTime;
  });
  a.addEventListener('timeupdate', function () {
    if (a.paused) return;
    if (Math.abs(b.currentTime - a.currentTime) > 0.3) b.currentTime = a.currentTime;
    if (b.paused) tryPlay(b);
  });

  // Feedback toggles: agree/disagree per row, click again to clear.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element) || !t.classList.contains('fb-btn')) return;
    var row = t.closest('.row');
    if (!row) return;
    var wasOn = t.classList.contains('on');
    row.querySelectorAll('.fb-btn').forEach(function (btn) { btn.classList.remove('on'); });
    if (!wasOn) t.classList.add('on');
  });

  // Compose the plain-text feedback summary and copy it to the clipboard.
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) { /* best effort */ }
    ta.remove();
  }
  var copyBtn = document.getElementById('copy-feedback');
  copyBtn.addEventListener('click', function () {
    var lines = [];
    lines.push('Flora Relight — review feedback');
    lines.push('Clip: ' + data.clip);
    lines.push('Run: ' + data.runId + ' · status: ' + data.status);
    lines.push(data.compositeLine);
    if (data.fallbackLine) lines.push(data.fallbackLine);
    lines.push('');
    document.querySelectorAll('.row[data-idx]').forEach(function (row) {
      var i = parseInt(row.getAttribute('data-idx'), 10);
      var ev = data.evals[i];
      if (!ev) return;
      var agree = row.querySelector('.fb-agree');
      var disagree = row.querySelector('.fb-disagree');
      var reviewer = agree && agree.classList.contains('on') ? 'agree'
        : disagree && disagree.classList.contains('on') ? 'disagree' : '—';
      var noteEl = row.querySelector('.fb-note');
      var note = noteEl && noteEl.value ? noteEl.value.trim() : '';
      var line = '- ' + ev.name + ': ' + ev.line + ' · reviewer: ' + reviewer;
      if (note) line += ' · note: ' + note;
      lines.push(line);
    });
    lines.push('');
    lines.push(data.footer);
    var text = lines.join('\\n');
    function done() {
      copyBtn.textContent = 'Copied — paste it to the team';
      setTimeout(function () { copyBtn.textContent = 'Copy feedback summary'; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else {
      legacyCopy(text);
      done();
    }
  });
})();
</script>
</body>
</html>
`;
}
