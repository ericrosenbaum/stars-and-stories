/**
 * Condense a story into a short (1–5 minute) audio cut that still tells the
 * whole story, keeps its funniest / most interesting moments, and gives Izzy
 * at least half of the airtime:
 *
 *   npx tsx condense.ts <story-slug> [options]
 *
 * Modes:
 *   (default)          plan the cut with Gemini, enforce the constraints, render
 *                      the audio and write a review page
 *   --suggest "..."    plan again with your feedback (earlier feedback is kept)
 *   --plan-only        write the plan (and review page) without rendering audio
 *   --render           re-render from the existing plan — use after hand-editing
 *                      the "lines" in condensed.json (no Gemini call)
 *   --remove           delete the story's condensed cut (plan + served audio)
 *
 * Options:
 *   --target 3m        length to aim for (default 3m)
 *   --min 1m --max 5m  hard bounds (defaults 1m / 5m)
 *   --izzy 50          minimum share of the cut Izzy must be speaking, in % (default 50)
 *   --gap 0.35         seconds of silence at each splice (default 0.35)
 *   --audio <path>     cut from this file instead of source.m4a / the served audio
 *   --no-build         don't rebuild the site data bundle afterwards
 *
 * Files:
 *   content/stories/<slug>/condensed/condensed.json   the plan: kept lines, cut ranges, metrics (committed)
 *   content/stories/<slug>/condensed/review.html      listen + inspect the cut (gitignored)
 *   site/public/media/<slug>/condensed.m4a            the served audio (committed, like header.webp)
 *
 * Durations are computed from transcript timestamps (a line lasts until the
 * next line starts), and each cut point is moved into the nearest detected
 * pause so words are not clipped. The planner proposes; the constraints are
 * then enforced in code (dropping Dad's optional lines first). Review the
 * result in review.html and iterate with --suggest, or hand-edit the plan.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONTENT_STORIES_DIR, SITE_MEDIA_DIR, ensureDir } from './lib/paths.ts';
import {
  DEFAULT_CONSTRAINTS,
  DEFAULT_GAP,
  buildSegments,
  detectSilences,
  enforceConstraints,
  fmtTime,
  loadPlan,
  measure,
  parseDuration,
  pct,
  probeDuration,
  renderCut,
  renderedDuration,
  reviewHtml,
  segmentsToRanges,
  snapRangesToSilence,
  violations,
  type CondensedPlan,
  type CutConstraints,
  type LinePick,
} from './lib/condense.ts';
import { planCondensedCut } from './lib/gemini.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord } from './lib/types.ts';

const PLANNER_ROUNDS = 3; // initial plan + up to two "please fix X" revisions

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const valueIdxs = new Set<number>();
function flagValue(name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`Missing value for ${name}.`);
    process.exit(1);
  }
  valueIdxs.add(idx + 1);
  return v;
}
const suggest = flagValue('--suggest');
const targetRaw = flagValue('--target');
const minRaw = flagValue('--min');
const maxRaw = flagValue('--max');
const izzyRaw = flagValue('--izzy');
const gapRaw = flagValue('--gap');
const audioOverride = flagValue('--audio');
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIdxs.has(i));
const slug = positional[0];

function usage(): never {
  console.error(
    'Usage: npx tsx condense.ts <story-slug> [--target 3m] [--min 1m] [--max 5m] [--izzy 50] [--gap 0.35]\n' +
      '                            [--suggest "..."] [--plan-only] [--render] [--remove] [--audio <file>] [--no-build]',
  );
  process.exit(1);
}
if (!slug) usage();
const modeFlags = ['--render', '--remove', '--plan-only'].filter((f) => flags.has(f));
if (modeFlags.length > 1) {
  console.error(`${modeFlags.join(' and ')} are mutually exclusive.`);
  process.exit(1);
}
if (suggest !== null && modeFlags.length) {
  console.error('--suggest plans a new cut; it cannot be combined with --render/--remove/--plan-only.');
  process.exit(1);
}

const storyDir = path.join(CONTENT_STORIES_DIR, slug);
const storyJsonPath = path.join(storyDir, 'story.json');
if (!fs.existsSync(storyJsonPath)) {
  console.error(`No story found at content/stories/${slug}/story.json`);
  const needle = slug.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const close = fs
    .readdirSync(CONTENT_STORIES_DIR)
    .filter((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(needle.slice(0, 8)))
    .slice(0, 5);
  if (close.length) console.error(`Did you mean: ${close.join(', ')}`);
  process.exit(1);
}
const story: StoryRecord = JSON.parse(fs.readFileSync(storyJsonPath, 'utf8'));
console.log(`Story: "${story.title}" (${slug}) — ${story.transcript.length} transcript lines`);

const condDir = path.join(storyDir, 'condensed');
const planPath = path.join(condDir, 'condensed.json');
const reviewPath = path.join(condDir, 'review.html');
const mediaDir = path.join(SITE_MEDIA_DIR, slug);
const outAudio = path.join(mediaDir, 'condensed.m4a');
const rel = (p: string) => path.relative(ROOT, p);

// ---- --remove ----
if (flags.has('--remove')) {
  const had = fs.existsSync(condDir) || fs.existsSync(outAudio);
  fs.rmSync(condDir, { recursive: true, force: true });
  fs.rmSync(outAudio, { force: true });
  console.log(had ? `Removed ${rel(condDir)} and ${rel(outAudio)}.` : 'This story had no condensed cut.');
  if (had && !flags.has('--no-build')) await buildSite();
  process.exit(0);
}

// ---- constraints (CLI flags > existing plan > defaults) ----
const existing = loadPlan(planPath);
const base: CutConstraints = { ...DEFAULT_CONSTRAINTS, ...(existing?.constraints ?? {}) };
const constraints: CutConstraints = {
  targetSec: targetRaw !== null ? parseDuration(targetRaw) : base.targetSec,
  minSec: minRaw !== null ? parseDuration(minRaw) : base.minSec,
  maxSec: maxRaw !== null ? parseDuration(maxRaw) : base.maxSec,
  izzyMinShare: izzyRaw !== null ? Number(izzyRaw.replace('%', '')) / 100 : base.izzyMinShare,
};
if (!(constraints.minSec <= constraints.targetSec && constraints.targetSec <= constraints.maxSec)) {
  console.error(`Need --min <= --target <= --max (got ${fmtTime(constraints.minSec)} / ${fmtTime(constraints.targetSec)} / ${fmtTime(constraints.maxSec)}).`);
  process.exit(1);
}
if (!(constraints.izzyMinShare >= 0 && constraints.izzyMinShare <= 1)) {
  console.error('--izzy expects a percentage between 0 and 100.');
  process.exit(1);
}
const gap = gapRaw !== null ? Number(gapRaw) : (existing?.gap ?? DEFAULT_GAP);
if (!Number.isFinite(gap) || gap < 0 || gap > 3) {
  console.error('--gap expects a number of seconds between 0 and 3.');
  process.exit(1);
}

// ---- audio: the original when it is on this machine, else the served copy ----
function locateAudio(): { path: string; source: 'source' | 'site' } {
  if (audioOverride) {
    if (!fs.existsSync(audioOverride)) {
      console.error(`--audio file not found: ${audioOverride}`);
      process.exit(1);
    }
    return { path: audioOverride, source: 'source' };
  }
  const src = path.join(storyDir, 'source.m4a');
  if (fs.existsSync(src)) return { path: src, source: 'source' };
  const served = path.join(mediaDir, 'audio.m4a');
  if (fs.existsSync(served)) return { path: served, source: 'site' };
  console.error(
    `No audio for "${slug}": neither ${rel(src)} nor ${rel(served)} exists. Pass --audio <file>.`,
  );
  process.exit(1);
}
const audio = locateAudio();
console.log(`Audio: ${rel(audio.path)}${audio.source === 'site' ? ' (the served copy — source.m4a is not on this machine)' : ''}`);
const audioDuration = await probeDuration(audio.path);
const segments = buildSegments(story.transcript, audioDuration);
const full = measure(segments, segments.map((s) => ({ i: s.i, priority: 1 as const })));
console.log(
  `Original: ${audioDuration ? fmtTime(audioDuration) : '?'} · Izzy ${pct(full.izzyShare)} of the airtime, ${pct(full.izzyWordShare)} of the words`,
);
console.log(
  `Constraints: ${fmtTime(constraints.minSec)}–${fmtTime(constraints.maxSec)} (aim ${fmtTime(constraints.targetSec)}), Izzy ≥ ${pct(constraints.izzyMinShare)} of the airtime`,
);

// ---- plan ----
let plan: CondensedPlan;
if (flags.has('--render')) {
  if (!existing) {
    console.error(`No plan at ${rel(planPath)} to render. Run without --render to plan one.`);
    process.exit(1);
  }
  // Hand-edited plans: re-validate the lines and recompute everything derived.
  const lines: LinePick[] = existing.lines
    .filter((l) => Number.isInteger(l.i) && l.i >= 0 && l.i < segments.length)
    .map((l) => ({ i: l.i, priority: ([1, 2, 3].includes(l.priority) ? l.priority : 2) as 1 | 2 | 3, why: l.why }))
    .sort((a, b) => a.i - b.i);
  if (!lines.length) {
    console.error('The plan keeps no valid lines.');
    process.exit(1);
  }
  const metrics = measure(segments, lines, gap);
  plan = {
    ...existing,
    constraints,
    lines,
    metrics,
    warnings: violations(metrics, constraints),
    gap,
    audioSource: audio.source,
    audioDuration,
    ranges: [],
    renderedDuration: 0,
  };
  console.log(`Re-rendering from the existing plan (${lines.length} lines; constraints are reported, not enforced, for a hand-edited plan).`);
} else {
  const feedback = [...(existing?.feedback ?? [])];
  if (suggest) feedback.push(suggest);
  if (existing && !suggest) console.log('Re-planning from scratch (pass --suggest "..." to steer it).');

  let picks: LinePick[] = [];
  let notes: string | undefined;
  let model = 'unknown';
  let rounds = 0;
  let revise: { previous: LinePick[]; problems: string[] } | undefined;
  for (let round = 1; round <= PLANNER_ROUNDS; round++) {
    rounds = round;
    console.log(round === 1 ? '\nPlanning the cut with Gemini...' : `\nAsking for a revision (round ${round})...`);
    const result = await planCondensedCut(story, segments, constraints, { feedback, revise });
    picks = result.picks;
    notes = result.notes;
    model = result.model;
    const m = measure(segments, picks, gap);
    const problems = violations(m, constraints);
    console.log(
      `  proposed ${picks.length} lines: ${fmtTime(m.durationSec)} of speech (~${fmtTime(m.renderedSec)} rendered), Izzy ${pct(m.izzyShare)} of the airtime` +
        (problems.length ? ` — ${problems.join('; ')}` : ' ✓'),
    );
    if (!problems.length) break;
    revise = { previous: picks, problems };
  }

  const enforced = enforceConstraints(segments, picks, constraints, gap);
  if (enforced.dropped.length) {
    console.log(
      `  trimmed ${enforced.dropped.length} line(s) to meet the constraints: ` +
        enforced.dropped.map((d) => `#${d.i} (${segments[d.i].speaker}, ${segments[d.i].dur.toFixed(0)}s)`).join(', '),
    );
  }
  if (enforced.added.length) console.log(`  added ${enforced.added.length} Izzy line(s) to reach the minimum length`);
  plan = {
    version: 1,
    createdAt: new Date().toISOString(),
    audioSource: audio.source,
    audioDuration,
    constraints,
    feedback,
    planner: { model, notes, rounds },
    lines: enforced.picks,
    dropped: enforced.dropped,
    ranges: [],
    gap,
    metrics: measure(segments, enforced.picks, gap),
    renderedDuration: 0,
    warnings: enforced.warnings,
  };
}

// ---- cut points ----
console.log('\nSnapping cut points to pauses in the recording...');
const silences = await detectSilences(audio.path);
console.log(`  ${silences.length} pauses found`);
plan.ranges = snapRangesToSilence(segmentsToRanges(segments, plan.lines), silences, { gap, audioDuration });
plan.renderedDuration = renderedDuration(plan.ranges, gap);

const m = plan.metrics;
console.log(
  `\nCut: ${plan.lines.length} lines in ${plan.ranges.length} range(s) → ${fmtTime(plan.renderedDuration)} · ` +
    `Izzy ${pct(m.izzyShare)} of the airtime (${m.izzyLines} of ${m.lines} lines, ${pct(m.izzyWordShare)} of the words)`,
);
if (plan.planner.notes) console.log(`Planner notes: ${plan.planner.notes}`);
for (const w of plan.warnings) console.warn(`WARNING: ${w}`);
console.log('');
for (const r of plan.ranges) {
  const first = segments[r.from], last = segments[r.to];
  const label = r.from === r.to ? `#${r.from}` : `#${r.from}–${r.to}`;
  console.log(`  ${fmtTime(r.cutStart)}–${fmtTime(r.cutEnd)}  ${label.padEnd(9)} ${first.speaker}: ${first.text.slice(0, 70)}${r.from !== r.to ? ` … ${last.speaker}: ${last.text.slice(0, 40)}` : ''}`);
}

// ---- write ----
ensureDir(condDir);
if (flags.has('--plan-only')) {
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`\nWrote ${rel(planPath)} (plan only — no audio rendered). Render it with: npm run condense -- ${slug} --render`);
} else {
  ensureDir(mediaDir);
  console.log(`\nRendering ${rel(outAudio)}...`);
  await renderCut(audio.path, plan.ranges, outAudio, { gap });
  plan.renderedAt = new Date().toISOString();
  const actual = await probeDuration(outAudio);
  if (actual != null) plan.renderedDuration = actual;
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`Wrote ${rel(planPath)} · audio ${actual ? fmtTime(actual) : '?'}, ${(fs.statSync(outAudio).size / 1024).toFixed(0)} KB`);
}
const fullAudioRel = fs.existsSync(path.join(mediaDir, 'audio.m4a')) ? path.relative(condDir, path.join(mediaDir, 'audio.m4a')) : null;
fs.writeFileSync(
  reviewPath,
  reviewHtml(slug, story.title, segments, plan, path.relative(condDir, outAudio), fullAudioRel),
);
console.log(`Review it:  open "${reviewPath}"`);

if (!flags.has('--plan-only') && !flags.has('--no-build')) {
  console.log('\nRebuilding site data...');
  await buildSite();
}
console.log(
  `\nNext: keep it (nothing to do) · new plan: npm run condense -- ${slug} --suggest "..." · ` +
    `hand-edit "lines" in condensed.json then: npm run condense -- ${slug} --render · remove: --remove`,
);
