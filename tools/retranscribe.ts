/**
 * Re-transcribe an existing story's audio with the improved pipeline (or a
 * different engine), keeping everything else about the story intact:
 *   npx tsx retranscribe.ts <slug> [options]
 *
 * Options:
 *   --engine <id>   gemini-flash (default) | gemini-pro | scribe-v2 | openai-diarize
 *   --quote         pick a fresh highlight quote from the new transcript
 *                   (default: keep the quote text, re-locate its timestamp)
 *   --no-build      don't rebuild the site bundle afterwards
 *
 * Preserved: id/slug, title, date, summary, characters, places, header image.
 * Replaced: transcript, word counts (and the quote's timestamp).
 * Requires content/stories/<slug>/source.m4a, which lives only on the
 * recording Mac. Review the result with git diff; revert with git checkout.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_STORIES_DIR, CONTENT_BAKEOFF_DIR, ROOT } from './lib/paths.ts';
import { ALL_ENGINES, runEngine, type EngineId } from './lib/asr.ts';
import { loadNameLexicon } from './lib/lexicon.ts';
import { computeWordCounts } from './lib/wordcount.ts';
import { recoverQuoteTimestamp } from './lib/quote.ts';
import { extractHighlightQuote } from './lib/gemini.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord, HighlightQuote } from './lib/types.ts';

// ---- args ----
const args = process.argv.slice(2);
const engineIdx = args.indexOf('--engine');
const engine = (engineIdx >= 0 ? args[engineIdx + 1] : 'gemini-flash') as EngineId;
const engineValIdx = engineIdx >= 0 ? engineIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== engineValIdx);
const slug = positional[0];

if (!slug) {
  console.error('Usage: npx tsx retranscribe.ts <slug> [--engine <id>] [--quote] [--no-build]');
  console.error(`Engines: ${ALL_ENGINES.join(', ')}`);
  process.exit(1);
}
if (!ALL_ENGINES.includes(engine)) {
  console.error(`Unknown engine "${engine}". Engines: ${ALL_ENGINES.join(', ')}`);
  process.exit(1);
}

const storyDir = path.join(CONTENT_STORIES_DIR, slug);
const storyJsonPath = path.join(storyDir, 'story.json');
if (!fs.existsSync(storyJsonPath)) {
  console.error(`No story "${slug}" under content/stories/.`);
  const needle = slug.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const close = fs
    .readdirSync(CONTENT_STORIES_DIR)
    .filter((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(needle.slice(0, 8)))
    .slice(0, 5);
  if (close.length) console.error(`Did you mean: ${close.join(', ')}`);
  process.exit(1);
}
const audioPath = path.join(storyDir, 'source.m4a');
if (!fs.existsSync(audioPath)) {
  console.error(
    `source.m4a for "${slug}" is not on this machine (source audio is gitignored and lives only on the recording Mac).\n` +
      `Run this tool there.`,
  );
  process.exit(1);
}

const record: StoryRecord = JSON.parse(fs.readFileSync(storyJsonPath, 'utf8'));
const oldCounts = {
  lines: record.transcript.length,
  izzy: record.izzyWordCount,
  dad: record.dadWordCount,
};

console.log(`Re-transcribing "${record.title}" (${slug}) with ${engine}...`);
console.log(`Tip: story.json is tracked by git — review with: git diff ${path.relative(ROOT, storyJsonPath)}`);

let durationSec: number | null = null;
try {
  const mm = await import('music-metadata');
  durationSec = (await mm.parseFile(audioPath)).format.duration ?? null;
} catch {
  /* best-effort, only used for the cost note */
}

const result = await runEngine(engine, audioPath, {
  lexicon: loadNameLexicon(),
  durationSec,
  // gitignored scratch area, so a raw-response dump can't get committed
  rawDumpDir: path.join(CONTENT_BAKEOFF_DIR, `retranscribe-${slug}`),
});
if (result.rawSpeakerMap) {
  const mapStr = Object.entries(result.rawSpeakerMap).map(([k, v]) => `${k} → ${v}`).join(', ');
  console.log(`Speaker mapping (${result.speakerMapMethod}): ${mapStr}`);
}

record.transcript = result.transcript;
Object.assign(record, computeWordCounts(result.transcript));

// The quote must point at the new transcript's timeline.
if (args.includes('--quote')) {
  console.log('Picking a fresh highlight quote...');
  const fresh = await extractHighlightQuote(result.transcript);
  if (fresh?.text) {
    record.highlightQuote = {
      text: fresh.text,
      timestamp:
        typeof fresh.timestamp === 'number'
          ? fresh.timestamp
          : recoverQuoteTimestamp(fresh.text, result.transcript),
    };
  } else {
    console.warn('  (quote extraction returned nothing — keeping the old quote)');
  }
}
if (record.highlightQuote?.text && !args.includes('--quote')) {
  const ts = recoverQuoteTimestamp(record.highlightQuote.text, result.transcript);
  if (ts == null) {
    console.warn('  (the existing highlight quote no longer matches a transcript line — its timestamp is now unset)');
  }
  record.highlightQuote = { text: record.highlightQuote.text, timestamp: ts } as HighlightQuote;
}

fs.writeFileSync(storyJsonPath, JSON.stringify(record, null, 2));

console.log(
  `\nTranscript replaced: ${oldCounts.lines} -> ${record.transcript.length} lines, ` +
    `Izzy ${oldCounts.izzy} -> ${record.izzyWordCount} words, Dad ${oldCounts.dad} -> ${record.dadWordCount} words.`,
);
if (result.estimatedCostUsd != null) {
  console.log(`Estimated cost: $${result.estimatedCostUsd.toFixed(3)} (${result.costNote})`);
}

if (!args.includes('--no-build')) {
  console.log('Rebuilding site bundle...');
  await buildSite();
}
console.log(`Done. Review: git diff ${path.relative(ROOT, storyJsonPath)}`);
