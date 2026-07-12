/**
 * Compare transcription engines side by side on real recordings:
 *   npx tsx bakeoff.ts <slug-or-audio-path> [more inputs...] [options]
 *
 * Options:
 *   --engines a,b,c   subset of: gemini-flash, gemini-pro, scribe-v2, openai-diarize
 *                     (default: all four; engines missing their API key are skipped)
 *   --name label      name for the run directory (default: slug/file basename)
 *
 * Each input produces content/bakeoff/<name>-<stamp>/ (gitignored) with the
 * audio, one <engine>.json per engine, and compare.html — open it, play the
 * audio, and judge the engines line by line (Izzy's lines are highlighted;
 * every column follows playback so drifting timestamps are visible).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CONTENT_STORIES_DIR, CONTENT_BAKEOFF_DIR, ROOT, ensureDir } from './lib/paths.ts';
import { ALL_ENGINES, engineAvailable, runEngine, type EngineId, type EngineResult } from './lib/asr.ts';
import { loadNameLexicon } from './lib/lexicon.ts';
import { computeWordCounts } from './lib/wordcount.ts';
import { compareHtml, fmtTime, type FailedEngine } from './lib/compare-html.ts';

// ---- args ----
const args = process.argv.slice(2);
function flagValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}
const enginesArg = flagValue('--engines');
const nameArg = flagValue('--name');
const flagValueIdxs = new Set(
  ['--engines', '--name'].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1),
);
const inputs = args.filter((a, i) => !a.startsWith('--') && !flagValueIdxs.has(i));

if (!inputs.length) {
  console.error('Usage: npx tsx bakeoff.ts <slug-or-audio-path> [more...] [--engines a,b,c] [--name label]');
  console.error(`Engines: ${ALL_ENGINES.join(', ')}`);
  process.exit(1);
}

const requested: EngineId[] = enginesArg
  ? (enginesArg.split(',').map((e) => e.trim()) as EngineId[])
  : [...ALL_ENGINES];
for (const e of requested) {
  if (!ALL_ENGINES.includes(e)) {
    console.error(`Unknown engine "${e}". Engines: ${ALL_ENGINES.join(', ')}`);
    process.exit(1);
  }
}

function resolveAudio(input: string): { audioPath: string; label: string } {
  const storyDir = path.join(CONTENT_STORIES_DIR, input);
  if (fs.existsSync(storyDir) && fs.statSync(storyDir).isDirectory()) {
    const src = path.join(storyDir, 'source.m4a');
    if (!fs.existsSync(src)) {
      console.error(
        `source.m4a for "${input}" is not on this machine (source audio is gitignored and lives only on the recording Mac).\n` +
          `Run the bake-off there, or pass an audio file path directly.`,
      );
      process.exit(1);
    }
    return { audioPath: src, label: input };
  }
  if (fs.existsSync(input)) return { audioPath: input, label: path.basename(input).replace(/\.[^.]+$/, '') };
  console.error(`"${input}" is neither a story slug under content/stories/ nor an existing audio file.`);
  process.exit(1);
  throw new Error('unreachable');
}

async function audioDuration(audioPath: string): Promise<number | null> {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(audioPath);
    return meta.format.duration ?? null;
  } catch {
    return null;
  }
}

// ---- main ----
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const lexicon = loadNameLexicon();

for (const input of inputs) {
  const { audioPath, label } = resolveAudio(input);
  // --name only applies cleanly to a single input; multiple inputs keep their own labels
  const runName = `${inputs.length === 1 && nameArg ? nameArg : label}-${stamp}`;
  const runDir = path.join(CONTENT_BAKEOFF_DIR, runName);
  ensureDir(runDir);
  fs.copyFileSync(audioPath, path.join(runDir, 'audio.m4a'));
  const durationSec = await audioDuration(audioPath);

  console.log(`\n=== ${label} ${durationSec ? `(${fmtTime(durationSec)})` : ''} ===`);
  const results: EngineResult[] = [];
  const failures: FailedEngine[] = [];

  for (const engine of requested) {
    const avail = engineAvailable(engine);
    if (!avail.ok) {
      console.log(`  skipping ${engine} (${avail.reason})`);
      continue;
    }
    process.stdout.write(`  ${engine}... `);
    try {
      const result = await runEngine(engine, audioPath, { lexicon, durationSec, rawDumpDir: runDir });
      results.push(result);
      fs.writeFileSync(path.join(runDir, `${engine}.json`), JSON.stringify(result, null, 2));
      console.log(`${result.transcript.length} lines in ${(result.elapsedMs / 1000).toFixed(1)}s`);
    } catch (e: any) {
      const message = e?.message || String(e);
      failures.push({ engine, error: message });
      console.log(`FAILED: ${message}`);
    }
  }

  if (!results.length && !failures.length) {
    console.error('\nNo engines ran — set at least one API key (GEMINI_API_KEY, ELEVENLABS_API_KEY, OPENAI_API_KEY) in tools/.env.');
    process.exit(1);
  }

  const htmlPath = path.join(runDir, 'compare.html');
  fs.writeFileSync(htmlPath, compareHtml(label, durationSec, results, failures));

  // summary table
  console.log('');
  const rows = [
    ['engine', 'lines', 'Izzy words', 'Dad words', 'time', 'est. cost'],
    ...results.map((r) => {
      const c = computeWordCounts(r.transcript);
      return [
        r.engine,
        String(r.transcript.length),
        String(c.izzyWordCount),
        String(c.dadWordCount),
        `${(r.elapsedMs / 1000).toFixed(1)}s`,
        r.estimatedCostUsd == null ? 'n/a' : `$${r.estimatedCostUsd.toFixed(3)}`,
      ];
    }),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const row of rows) console.log('  ' + row.map((cell, i) => cell.padEnd(widths[i] + 2)).join(''));

  console.log(`\n  Review: open "${path.relative(ROOT, htmlPath)}"`);
  execFile('open', [htmlPath], (err) => {
    if (err) console.log(`  (couldn't auto-open — open the file above manually)`);
  });
}
