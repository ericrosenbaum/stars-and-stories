/**
 * Condensed cuts: turn a full Stars & Stories episode into a 1–5 minute audio
 * edit that still tells a complete story, keeps the funniest / most interesting
 * moments, and gives Izzy at least half of the airtime.
 *
 * The transcript has one start timestamp per line and no word timings, so the
 * unit of editing is the transcript LINE: a cut keeps whole lines, each line
 * spanning from its own timestamp to the next line's. The pieces here are
 * deliberately model-free (the Gemini planner lives in gemini.ts) so the
 * constraint math, cut-point snapping and ffmpeg rendering are testable and
 * usable with a hand-edited plan.
 *
 *   transcript ──► buildSegments ──► (planner picks lines) ──► enforceConstraints
 *              ──► segmentsToRanges ──► snapRangesToSilence ──► renderCut (ffmpeg)
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { runFfmpeg } from './media.ts';
import { countWords } from './wordcount.ts';
import type { TranscriptItem } from './types.ts';

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/** One transcript line with a derived end time — the atom of a cut. */
export interface CutSegment {
  i: number; // index into the story transcript
  speaker: string;
  text: string;
  start: number;
  end: number; // next line's start (or an estimate for the last / out-of-order lines)
  dur: number;
  words: number;
  izzy: boolean;
}

export const isIzzy = (speaker: string) => (speaker || '').toLowerCase().includes('izzy');

/** Rough spoken length of a line, for lines whose end can't be read off the next timestamp. */
function estimateDuration(words: number): number {
  return Math.min(20, Math.max(1.5, 0.45 * words + 0.8));
}

export function buildSegments(transcript: TranscriptItem[], audioDuration: number | null): CutSegment[] {
  const segs: CutSegment[] = [];
  for (let i = 0; i < transcript.length; i++) {
    const item = transcript[i];
    const start = Math.max(0, Number(item.timestamp) || 0);
    const words = countWords(item.text);
    // Find the next line that starts after this one (timestamps are non-decreasing
    // in theory; be robust to the odd out-of-order line).
    let end: number | null = null;
    for (let j = i + 1; j < transcript.length; j++) {
      const t = Number(transcript[j].timestamp);
      if (Number.isFinite(t) && t > start) {
        end = t;
        break;
      }
    }
    if (end == null) end = start + estimateDuration(words);
    if (audioDuration != null && audioDuration > start) end = Math.min(end, audioDuration);
    // A same-second neighbour would give a zero-length line; give it a floor.
    if (end - start < 0.6) end = start + Math.min(estimateDuration(words), 2);
    segs.push({
      i,
      speaker: item.speaker,
      text: item.text,
      start,
      end,
      dur: end - start,
      words,
      izzy: isIzzy(item.speaker),
    });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Constraints & metrics
// ---------------------------------------------------------------------------

export interface CutConstraints {
  targetSec: number;
  minSec: number;
  maxSec: number;
  /** Minimum share of the cut's duration that must be Izzy speaking (0–1). */
  izzyMinShare: number;
}

export const DEFAULT_CONSTRAINTS: CutConstraints = {
  targetSec: 180,
  minSec: 60,
  maxSec: 300,
  izzyMinShare: 0.5,
};

/** A planner's choice of one line. Priority: 1 = needed for the story to make
 *  sense, 2 = a great moment, 3 = nice to have (dropped first when trimming). */
export interface LinePick {
  i: number;
  priority: 1 | 2 | 3;
  why?: string;
}

export interface CutMetrics {
  durationSec: number;
  izzySec: number;
  dadSec: number;
  izzyShare: number; // by duration — the enforced measure
  izzyWords: number;
  dadWords: number;
  izzyWordShare: number;
  lines: number;
  izzyLines: number;
  /** Runs of consecutive kept lines — each splice adds a gap and a little padding. */
  ranges: number;
  /** durationSec plus the splice overhead: what the rendered file will roughly measure. */
  renderedSec: number;
}

/** Silence inserted at each splice, plus the lead-in/lead-out padding a range picks up. */
export const DEFAULT_GAP = 0.35;
const RANGE_PADDING = 0.55;

export function measure(segments: CutSegment[], picks: LinePick[], gap = DEFAULT_GAP): CutMetrics {
  let izzySec = 0, dadSec = 0, izzyWords = 0, dadWords = 0, izzyLines = 0, ranges = 0;
  const kept = new Set(picks.map((p) => p.i));
  for (const p of picks) {
    if (!kept.has(p.i - 1)) ranges++;
    const s = segments[p.i];
    if (!s) continue;
    if (s.izzy) {
      izzySec += s.dur;
      izzyWords += s.words;
      izzyLines++;
    } else {
      dadSec += s.dur;
      dadWords += s.words;
    }
  }
  const durationSec = izzySec + dadSec;
  return {
    durationSec,
    izzySec,
    dadSec,
    izzyShare: durationSec ? izzySec / durationSec : 0,
    izzyWords,
    dadWords,
    izzyWordShare: izzyWords + dadWords ? izzyWords / (izzyWords + dadWords) : 0,
    lines: picks.length,
    izzyLines,
    ranges,
    renderedSec: durationSec + Math.max(0, ranges - 1) * gap + ranges * RANGE_PADDING,
  };
}

/** Human-readable list of what a selection violates (empty = it satisfies the constraints). */
export function violations(m: CutMetrics, c: CutConstraints): string[] {
  const out: string[] = [];
  if (m.renderedSec > c.maxSec) out.push(`too long: ${fmtTime(m.renderedSec)} > max ${fmtTime(c.maxSec)}`);
  if (m.renderedSec < c.minSec) out.push(`too short: ${fmtTime(m.renderedSec)} < min ${fmtTime(c.minSec)}`);
  if (m.izzyShare < c.izzyMinShare) {
    out.push(`Izzy has ${pct(m.izzyShare)} of the airtime, needs at least ${pct(c.izzyMinShare)}`);
  }
  return out;
}

/** Validate/normalize raw planner output against the transcript. */
export function normalizePicks(raw: unknown, segments: CutSegment[]): LinePick[] {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  const picks: LinePick[] = [];
  for (const r of arr) {
    const i = Number((r as any)?.i);
    if (!Number.isInteger(i) || i < 0 || i >= segments.length || seen.has(i)) continue;
    seen.add(i);
    const pRaw = Number((r as any)?.priority);
    const priority = (pRaw === 1 || pRaw === 2 || pRaw === 3 ? pRaw : 2) as 1 | 2 | 3;
    const why = typeof (r as any)?.why === 'string' ? (r as any).why.trim() : undefined;
    picks.push({ i, priority, why: why || undefined });
  }
  return picks.sort((a, b) => a.i - b.i);
}

export interface EnforceResult {
  picks: LinePick[];
  dropped: LinePick[];
  added: LinePick[];
  warnings: string[];
}

/**
 * Deterministic fix-up after the planner has had its say: drop Dad lines
 * (lowest priority first, longest first within a priority) until the cut is
 * under the max length and Izzy has her share; if it is still under the
 * minimum length, add Izzy lines adjacent to kept ones. Priority-1 lines are
 * never dropped, so a cut can end up violating a constraint — that is reported
 * in `warnings` rather than silently "fixed" by gutting the story.
 */
export function enforceConstraints(
  segments: CutSegment[],
  input: LinePick[],
  c: CutConstraints,
  gap = DEFAULT_GAP,
): EnforceResult {
  let picks = [...input].sort((a, b) => a.i - b.i);
  const dropped: LinePick[] = [];
  const added: LinePick[] = [];
  const warnings: string[] = [];

  const droppable = () =>
    picks
      .filter((p) => !segments[p.i].izzy && p.priority > 1)
      .sort((a, b) => b.priority - a.priority || segments[b.i].dur - segments[a.i].dur);

  // 1. Izzy share and max length: shed Dad lines.
  for (;;) {
    const m = measure(segments, picks, gap);
    if (m.izzyShare >= c.izzyMinShare && m.renderedSec <= c.maxSec) break;
    const cand = droppable();
    if (!cand.length) break;
    const victim = cand[0];
    picks = picks.filter((p) => p.i !== victim.i);
    dropped.push(victim);
  }
  // Still too long with only essential Dad lines left? Shed priority-3 then
  // priority-2 Izzy lines (shortest first — keep her big moments).
  for (;;) {
    const m = measure(segments, picks, gap);
    if (m.renderedSec <= c.maxSec) break;
    const cand = picks
      .filter((p) => segments[p.i].izzy && p.priority > 1)
      .sort((a, b) => b.priority - a.priority || segments[a.i].dur - segments[b.i].dur);
    if (!cand.length) break;
    picks = picks.filter((p) => p.i !== cand[0].i);
    dropped.push(cand[0]);
  }

  // 2. Min length: add Izzy lines that touch an already-kept line (longest first,
  //    so the additions are substantive rather than "yeah").
  for (;;) {
    const m = measure(segments, picks, gap);
    if (m.renderedSec >= c.minSec) break;
    const kept = new Set(picks.map((p) => p.i));
    const cand = segments
      .filter((s) => s.izzy && !kept.has(s.i) && (kept.has(s.i - 1) || kept.has(s.i + 1)))
      .sort((a, b) => b.dur - a.dur);
    if (!cand.length) break;
    const add: LinePick = { i: cand[0].i, priority: 3, why: 'added to reach the minimum length' };
    picks.push(add);
    picks.sort((a, b) => a.i - b.i);
    added.push(add);
  }

  for (const v of violations(measure(segments, picks, gap), c)) warnings.push(v);
  return { picks, dropped, added, warnings };
}

/**
 * A model-free planner: scores lines (Izzy first, substantive over one-word
 * reactions, exclamations and named things up, meta-chatter down; the opening
 * and closing lines always in) and fills to the target from the top. Used by
 * FAKE_GEMINI mode and as the last-resort fallback when the model call fails,
 * so the pipeline can always be exercised without API spend.
 */
export function heuristicPicks(segments: CutSegment[], c: CutConstraints): LinePick[] {
  const n = segments.length;
  const score = (s: CutSegment) => {
    let sc = s.izzy ? 3 : 0.5;
    if (s.words >= 6) sc += 1.5;
    if (s.words <= 2) sc -= 1.5;
    if (/[!?]/.test(s.text)) sc += 0.5;
    if (/\b[A-Z][a-z]{3,}\b/.test(s.text.replace(/^\w/, (ch) => ch.toLowerCase()))) sc += 0.5; // a name mid-line
    if (/\b(record|microphone|lamp|light|blanket|okay|all right|alright)\b/i.test(s.text)) sc -= 1;
    return sc;
  };
  const picks = new Map<number, LinePick>();
  const add = (i: number, priority: 1 | 2 | 3, why: string) => {
    if (i >= 0 && i < n && !picks.has(i)) picks.set(i, { i, priority, why });
  };
  // Story frame: first substantive line and the ending.
  const firstStory = segments.find((s) => s.words >= 5 && !/\b(record|stars and stories)\b/i.test(s.text)) ?? segments[0];
  if (firstStory) add(firstStory.i, 1, 'opening');
  if (n) add(n - 1, 1, 'ending');
  if (n > 1 && segments[n - 2].izzy) add(n - 2, 2, 'ending');
  const ranked = [...segments].sort((a, b) => score(b) - score(a));
  for (const s of ranked) {
    const m = measure(segments, [...picks.values()]);
    if (m.renderedSec >= c.targetSec) break;
    add(s.i, s.izzy ? 2 : 3, s.izzy ? 'Izzy moment' : 'context');
  }
  return [...picks.values()].sort((a, b) => a.i - b.i);
}

// ---------------------------------------------------------------------------
// Ranges (runs of consecutive kept lines) and cut-point snapping
// ---------------------------------------------------------------------------

export interface CutRange {
  from: number; // first transcript index in the run
  to: number; // last transcript index in the run (inclusive)
  start: number; // segments[from].start
  end: number; // segments[to].end
  cutStart: number; // actual cut points after snapping / padding
  cutEnd: number;
  at: number; // where this range begins in the rendered cut (seconds)
}

export function segmentsToRanges(segments: CutSegment[], picks: LinePick[]): CutRange[] {
  const idx = [...new Set(picks.map((p) => p.i))].sort((a, b) => a - b);
  const ranges: CutRange[] = [];
  for (const i of idx) {
    const last = ranges[ranges.length - 1];
    if (last && last.to === i - 1) {
      last.to = i;
      last.end = segments[i].end;
      last.cutEnd = last.end;
    } else {
      const s = segments[i];
      ranges.push({ from: i, to: i, start: s.start, end: s.end, cutStart: s.start, cutEnd: s.end, at: 0 });
    }
  }
  return ranges;
}

export interface Silence {
  start: number;
  end: number;
}

/** Duration in seconds via ffprobe (null when unreadable). */
export function probeDuration(audioPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', audioPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try {
        const d = Number(JSON.parse(out)?.format?.duration);
        resolve(Number.isFinite(d) ? d : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Pauses in the recording, via ffmpeg's silencedetect. The threshold is set
 * relative to the file's mean loudness so a quiet bedroom recording and a
 * loud one both yield usable pause maps.
 */
export async function detectSilences(
  audioPath: string,
  opts: { minDur?: number; noiseDb?: number } = {},
): Promise<Silence[]> {
  const minDur = opts.minDur ?? 0.15;
  let noiseDb = opts.noiseDb;
  if (noiseDb == null) {
    const mean = await meanVolumeDb(audioPath);
    noiseDb = mean == null ? -35 : Math.max(-45, Math.min(-25, mean - 8));
  }
  const err = await ffmpegStderr(['-i', audioPath, '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-']);
  const silences: Silence[] = [];
  let open: number | null = null;
  for (const line of err.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Number(s[1]);
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && open != null) {
      silences.push({ start: Math.max(0, open), end: Number(e[1]) });
      open = null;
    }
  }
  return silences;
}

async function meanVolumeDb(audioPath: string): Promise<number | null> {
  const err = await ffmpegStderr(['-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = err.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  return m ? Number(m[1]) : null;
}

function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostats', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) =>
      reject(new Error(`Failed to launch ffmpeg (is it installed? \`brew install ffmpeg\`): ${e.message}`)),
    );
    proc.on('close', () => resolve(err));
  });
}

export interface SnapOptions {
  /** Farthest a cut may move in the SAFE direction (earlier for a start, later
   *  for an end): it only adds a sliver of a neighbouring line. */
  safeMove?: number;
  /** Farthest a cut may move in the CLIPPING direction (later for a start,
   *  earlier for an end): a real pause there means the timestamp was early/late,
   *  but moving further would eat into the kept line itself. */
  clipMove?: number;
  /** Padding used when no pause is nearby. */
  leadIn?: number;
  leadOut?: number;
  /** Silence between non-adjacent ranges in the rendered cut. */
  gap?: number;
  audioDuration?: number | null;
}

/**
 * Transcript timestamps are line starts, often rounded to the second, so a cut
 * placed exactly there can clip a word. Move each cut point into the nearest
 * pause when one is close (within the caps above), otherwise pad a little.
 * Also fills in `at`, the position of each range in the rendered cut.
 */
export function snapRangesToSilence(ranges: CutRange[], silences: Silence[], opts: SnapOptions = {}): CutRange[] {
  const safeMove = opts.safeMove ?? 1.0;
  const clipMove = opts.clipMove ?? 0.5;
  const leadIn = opts.leadIn ?? 0.25;
  const leadOut = opts.leadOut ?? 0.15;
  const gap = opts.gap ?? DEFAULT_GAP;
  const dur = opts.audioDuration ?? null;
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

  const out: CutRange[] = [];
  let at = 0;
  for (let k = 0; k < ranges.length; k++) {
    const r = { ...ranges[k] };
    // Start: the pause whose END is closest to the line's timestamp, within the
    // allowed movement; cut a touch before speech resumes.
    const lo = r.start - safeMove, hi = r.start + clipMove;
    const sIn = sorted
      .filter((s) => s.end >= lo && s.end <= hi)
      .sort((a, b) => Math.abs(a.end - r.start) - Math.abs(b.end - r.start))[0];
    r.cutStart = sIn ? clamp(Math.max(sIn.start, sIn.end - 0.15), lo, hi) : r.start - leadIn;
    // End: the pause whose START is closest to the next line's timestamp; cut a
    // touch after speech stops.
    const elo = r.end - clipMove, ehi = r.end + safeMove;
    const sOut = sorted
      .filter((s) => s.start >= elo && s.start <= ehi)
      .sort((a, b) => Math.abs(a.start - r.end) - Math.abs(b.start - r.end))[0];
    r.cutEnd = sOut ? clamp(Math.min(sOut.end, sOut.start + 0.2), elo, ehi) : r.end + leadOut;

    r.cutStart = Math.max(0, r.cutStart);
    if (dur != null) r.cutEnd = Math.min(dur, r.cutEnd);
    const prev = out[out.length - 1];
    if (prev && r.cutStart < prev.cutEnd) r.cutStart = prev.cutEnd;
    if (r.cutEnd < r.cutStart + 0.4) r.cutEnd = r.cutStart + 0.4;
    r.at = at;
    at += r.cutEnd - r.cutStart + (k < ranges.length - 1 ? gap : 0);
    out.push(r);
  }
  return out;
}

/** Total rendered length, including the gaps between ranges. */
export function renderedDuration(ranges: CutRange[], gap = DEFAULT_GAP): number {
  return ranges.reduce((sum, r, k) => sum + (r.cutEnd - r.cutStart) + (k < ranges.length - 1 ? gap : 0), 0);
}

/** Position of an original-audio time inside the rendered cut, or null if it was cut out. */
export function toCutTime(ranges: CutRange[], t: number): number | null {
  for (const r of ranges) {
    if (t >= r.cutStart && t <= r.cutEnd) return r.at + (t - r.cutStart);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  gap?: number; // seconds of silence between non-adjacent ranges
  bitrate?: string; // AAC bitrate
  fade?: number; // seconds of fade at every cut edge (removes clicks)
}

/** Cut the ranges out of `audioPath` and stitch them into a mono AAC .m4a. */
export async function renderCut(audioPath: string, ranges: CutRange[], outPath: string, opts: RenderOptions = {}): Promise<void> {
  if (!ranges.length) throw new Error('Nothing to render: the cut has no ranges.');
  const gap = opts.gap ?? DEFAULT_GAP;
  const fade = opts.fade ?? 0.03;
  const bitrate = opts.bitrate ?? '48k';
  const parts: string[] = [];
  const labels: string[] = [];
  ranges.forEach((r, k) => {
    const len = r.cutEnd - r.cutStart;
    const chain = [
      `atrim=start=${r.cutStart.toFixed(3)}:end=${r.cutEnd.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      `afade=t=in:st=0:d=${fade}`,
      `afade=t=out:st=${Math.max(0, len - fade).toFixed(3)}:d=${fade}`,
    ];
    if (k < ranges.length - 1 && gap > 0) chain.push(`apad=pad_dur=${gap}`);
    parts.push(`[0:a]${chain.join(',')}[c${k}]`);
    labels.push(`[c${k}]`);
  });
  parts.push(`${labels.join('')}concat=n=${ranges.length}:v=0:a=1[out]`);
  await runFfmpeg([
    '-y',
    '-i', audioPath,
    '-filter_complex', parts.join(';'),
    '-map', '[out]',
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', bitrate,
    '-movflags', '+faststart',
    outPath,
  ]);
}

// ---------------------------------------------------------------------------
// The on-disk plan (content/stories/<slug>/condensed/condensed.json)
// ---------------------------------------------------------------------------

export interface CondensedPlan {
  version: 1;
  createdAt: string;
  renderedAt?: string;
  /** Which audio the cut points were snapped against / rendered from. */
  audioSource: 'source' | 'site';
  audioDuration: number | null;
  constraints: CutConstraints;
  /** User feedback that shaped this plan (accumulates across --suggest runs). */
  feedback: string[];
  planner: { model: string; notes?: string; rounds: number };
  lines: LinePick[];
  dropped: LinePick[]; // lines the planner wanted that the constraints removed
  ranges: CutRange[];
  gap: number;
  metrics: CutMetrics;
  renderedDuration: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Parse "3m", "2:30", "150", "2m30s", "90s" into seconds. */
export function parseDuration(raw: string): number {
  const s = raw.trim().toLowerCase();
  let m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s?)?$/);
  if (m && (m[1] || m[2])) return Number(m[1] || 0) * 60 + Number(m[2] || 0);
  throw new Error(`Can't parse duration "${raw}" (try 3m, 2:30, 2m30s or 150)`);
}

/** The transcript lines as the planner sees them: one numbered line each. */
export function segmentsForPrompt(segments: CutSegment[]): string {
  return segments
    .map((s) => `#${s.i} [${s.speaker} @${fmtTime(s.start)} ${s.dur.toFixed(1)}s] ${s.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Review page
// ---------------------------------------------------------------------------

/**
 * A self-contained review page next to the plan (same single-file pattern as
 * the candidate gallery / bake-off page): the condensed audio and the original
 * side by side, every transcript line with the kept ones highlighted, and a
 * "cut only" view. Clicking a kept line plays it in the condensed audio.
 */
export function reviewHtml(
  slug: string,
  title: string,
  segments: CutSegment[],
  plan: CondensedPlan,
  cutAudioRel: string,
  fullAudioRel: string | null,
): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const data = JSON.stringify({
    segments: segments.map((s) => ({ i: s.i, speaker: s.speaker, text: s.text, start: s.start, dur: s.dur, izzy: s.izzy })),
    lines: plan.lines,
    dropped: plan.dropped,
    ranges: plan.ranges,
  }).replace(/</g, '\\u003c');
  const m = plan.metrics;
  const warn = plan.warnings.length
    ? `<p class="warn">⚠ ${plan.warnings.map(esc).join(' · ')}</p>`
    : '';
  const feedback = plan.feedback.length
    ? `<p class="stat">feedback so far: ${plan.feedback.map((f) => `“${esc(f)}”`).join(' → ')}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Condensed cut — ${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #faf8f4; color: #222; }
  header { position: sticky; top: 0; z-index: 10; background: #fffdf8; border-bottom: 1px solid #ddd; padding: .8rem 1.2rem; }
  header h1 { font-size: 1.1rem; margin: 0 0 .2rem; }
  .players { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: .5rem; }
  .player { flex: 1 1 320px; background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: .5rem .8rem; }
  .player h2 { font-size: .85rem; margin: 0 0 .3rem; color: #555; }
  .player.cut { border-color: #b8860b; background: #fffaf0; }
  .player audio { width: 100%; height: 36px; }
  .stat { font-size: .82rem; color: #666; margin: .15rem 0; }
  .warn { font-size: .85rem; color: #a33; margin: .3rem 0; }
  .controls { font-size: .85rem; color: #555; display: flex; gap: 1rem; align-items: center; margin-top: .5rem; flex-wrap: wrap; }
  main { padding: 1rem 1.2rem 40vh; max-width: 980px; margin: 0 auto; }
  .line { display: flex; gap: .6rem; padding: .35rem .5rem; border-radius: 8px; font-size: .92rem; line-height: 1.4; align-items: baseline; cursor: pointer; }
  .line:hover { background: #f2ede2; }
  .line .ts { color: #999; font-size: .75rem; font-variant-numeric: tabular-nums; flex: 0 0 3rem; }
  .line b { flex: 0 0 2.6rem; font-size: .78rem; color: #555; }
  .line.izzy b { color: #7a4ea8; }
  .line.out { opacity: .42; }
  .line.kept { background: #fdf6e3; }
  .line.kept.izzy { background: #f4ecfb; }
  .line.kept .tag { font-size: .7rem; color: #b8860b; margin-left: .4rem; white-space: nowrap; }
  .line.dropped .tag { font-size: .7rem; color: #a33; margin-left: .4rem; }
  .line.now { outline: 2px solid #b8860b; }
  .cutmark { border-top: 2px dashed #b8860b; margin: .5rem 0; height: 0; }
  body.cutonly .line.out { display: none; }
  body.cutonly .cutmark { display: block; }
  .cutmark { display: none; }
  footer { max-width: 980px; margin: 0 auto; padding: 1rem 1.2rem 3rem; font-size: .85rem; color: #666; }
  code { background: #f0ece4; padding: .1rem .3rem; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>Condensed cut — ${esc(title)}</h1>
  <p class="stat">${fmtTime(plan.renderedDuration)} · ${m.lines} of ${segments.length} lines · Izzy ${pct(m.izzyShare)} of the airtime (${pct(m.izzyWordShare)} of the words) · ${plan.ranges.length} cuts · planner: ${esc(plan.planner.model)}</p>
  ${plan.planner.notes ? `<p class="stat">planner notes: ${esc(plan.planner.notes)}</p>` : ''}
  ${feedback}
  ${warn}
  <div class="players">
    <div class="player cut"><h2>Condensed (${fmtTime(plan.renderedDuration)})</h2><audio id="cut" controls src="${esc(cutAudioRel)}" preload="metadata"></audio></div>
    ${fullAudioRel ? `<div class="player"><h2>Original (${plan.audioDuration ? fmtTime(plan.audioDuration) : '?'})</h2><audio id="full" controls src="${esc(fullAudioRel)}" preload="metadata"></audio></div>` : ''}
  </div>
  <div class="controls">
    <label><input type="checkbox" id="cutonly" /> show only the kept lines</label>
    <label><input type="checkbox" id="follow" checked /> follow playback</label>
    <span>click a kept line to play it in the cut · click a cut line to hear it in the original</span>
  </div>
</header>
<main id="lines"></main>
<footer>
  <p><b>Next steps</b> (from <code>tools/</code>):
  keep it → nothing to do, it is already rendered and will publish on the next build ·
  new plan with feedback → <code>npm run condense -- ${esc(slug)} --suggest "..."</code> ·
  hand-edit → change <code>lines</code> in <code>condensed.json</code>, then <code>npm run condense -- ${esc(slug)} --render</code> ·
  remove → <code>npm run condense -- ${esc(slug)} --remove</code></p>
</footer>
<script>
const DATA = ${data};
const cut = document.getElementById('cut');
const full = document.getElementById('full');
const root = document.getElementById('lines');
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmt = (t) => Math.floor(t/60) + ':' + String(Math.floor(t%60)).padStart(2,'0');
const kept = new Map(DATA.lines.map((l) => [l.i, l]));
const dropped = new Map(DATA.dropped.map((l) => [l.i, l]));
const rangeFor = (i) => DATA.ranges.find((r) => i >= r.from && i <= r.to);
const inCut = (s) => { const r = rangeFor(s.i); return r ? r.at + Math.max(0, s.start - r.cutStart) : null; };
document.getElementById('cutonly').addEventListener('change', (e) => document.body.classList.toggle('cutonly', e.target.checked));
const els = [];
let lastRange = null;
for (const s of DATA.segments) {
  const pick = kept.get(s.i);
  const r = pick ? rangeFor(s.i) : null;
  if (pick && r && lastRange && r !== lastRange) { const hr = document.createElement('div'); hr.className = 'cutmark'; root.appendChild(hr); }
  if (pick && r) lastRange = r;
  const div = document.createElement('div');
  div.className = 'line ' + (s.izzy ? 'izzy' : 'dad') + (pick ? ' kept' : ' out') + (dropped.has(s.i) ? ' dropped' : '');
  let tag = '';
  if (pick) tag = '<span class="tag" title="' + esc(pick.why || '') + '">✂ p' + pick.priority + (pick.why ? ' · ' + esc(pick.why) : '') + '</span>';
  else if (dropped.has(s.i)) tag = '<span class="tag" title="the planner wanted this line; the constraints removed it">✕ trimmed</span>';
  div.innerHTML = '<span class="ts">' + fmt(s.start) + '</span><b>' + esc(s.speaker) + '</b><span>' + esc(s.text) + tag + '</span>';
  div.addEventListener('click', () => {
    const t = inCut(s);
    if (t != null) { if (full) full.pause(); cut.currentTime = t; cut.play().catch(() => {}); }
    else if (full) { cut.pause(); full.currentTime = s.start; full.play().catch(() => {}); }
  });
  root.appendChild(div);
  els.push({ el: div, s });
}
let cur = null;
function highlight(el) {
  if (cur === el) return;
  if (cur) cur.classList.remove('now');
  cur = el; if (!el) return;
  el.classList.add('now');
  if (document.getElementById('follow').checked) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
cut.addEventListener('timeupdate', () => {
  const t = cut.currentTime;
  let best = null;
  for (const e of els) { const at = inCut(e.s); if (at != null && at <= t + 0.05) best = e.el; }
  highlight(best);
});
if (full) full.addEventListener('timeupdate', () => {
  const t = full.currentTime;
  let best = null;
  for (const e of els) { if (e.s.start <= t) best = e.el; }
  highlight(best);
});
</script>
</body>
</html>`;
}

/** Load a plan file, or null when the story has no condensed cut. */
export function loadPlan(file: string): CondensedPlan | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CondensedPlan;
}
