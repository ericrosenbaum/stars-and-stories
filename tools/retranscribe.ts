/**
 * Re-transcribe existing stories with ElevenLabs Scribe (the archive's one
 * engine), keeping everything else about each story intact:
 *   npx tsx retranscribe.ts <slug> [--no-build]
 *   npx tsx retranscribe.ts --all [--limit N] [--force] [--no-build]
 *
 * --all works through every story that has not yet been transcribed by Scribe
 * with the complete keyterm list (recorded in story.json's `transcription`
 * block), oldest first; --limit N does the next N so a batch can be committed
 * before continuing; --force re-does stories already marked done.
 *
 * Preserved: id/slug, title, date, summary, characters, places, header image,
 * the highlight quote's text. Replaced: transcript, word counts, `transcription`
 * metadata. The quote's timestamp is re-located against the new transcript and
 * falls back to its previous value (the audio timeline is unchanged).
 *
 * Speaker labels are mapped by aligning the new segments with the previous
 * transcript's Dad/Izzy labels in time; low-confidence mappings are listed at
 * the end for a human glance. Requires content/stories/<slug>/source.m4a
 * (recording Mac only). Exit codes: 0 ok, 1 usage/error, 2 repeated failures,
 * 3 ElevenLabs quota exhausted (stop the batch; nothing half-written).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_STORIES_DIR, CONTENT_BAKEOFF_DIR, ROOT } from './lib/paths.ts';
import { ARCHIVE_ENGINE, QuotaExceededError, audioDurationSec, describeMapping, runEngine } from './lib/asr.ts';
import { loadKeyterms } from './lib/lexicon.ts';
import { computeWordCounts } from './lib/wordcount.ts';
import { recoverQuoteTimestamp } from './lib/quote.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord } from './lib/types.ts';

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const positional = args.filter((a, i) => !a.startsWith('--') && !(limitIdx >= 0 && i === limitIdx + 1));
const slugArg = positional[0];
const all = flags.has('--all');

if ((!slugArg && !all) || (slugArg && all) || (limitIdx >= 0 && (!Number.isInteger(limit) || limit < 1))) {
  console.error('Usage: npx tsx retranscribe.ts <slug> [--no-build]   |   --all [--limit N] [--force] [--no-build]');
  process.exit(1);
}

const storyJsonPath = (slug: string) => path.join(CONTENT_STORIES_DIR, slug, 'story.json');
const readStory = (slug: string): StoryRecord => JSON.parse(fs.readFileSync(storyJsonPath(slug), 'utf8'));

/** Done = already transcribed by Scribe WITH the keyterm list. */
const isDone = (r: StoryRecord) => r.transcription?.engine === ARCHIVE_ENGINE && (r.transcription?.keyterms ?? 0) > 0;

// ---- targets ----
let targets: string[];
if (slugArg) {
  if (!fs.existsSync(storyJsonPath(slugArg))) {
    console.error(`No story "${slugArg}" under content/stories/.`);
    const needle = slugArg.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const close = fs
      .readdirSync(CONTENT_STORIES_DIR)
      .filter((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(needle.slice(0, 8)))
      .slice(0, 5);
    if (close.length) console.error(`Did you mean: ${close.join(', ')}`);
    process.exit(1);
  }
  targets = [slugArg];
} else {
  const stories = fs
    .readdirSync(CONTENT_STORIES_DIR)
    .filter((s) => fs.existsSync(storyJsonPath(s)))
    .map((s) => ({ slug: s, record: readStory(s) }))
    .sort((a, b) => new Date(a.record.date).getTime() - new Date(b.record.date).getTime());
  const pending = stories.filter((s) => flags.has('--force') || !isDone(s.record));
  targets = pending.slice(0, limit === Infinity ? undefined : limit).map((s) => s.slug);
  console.log(`${stories.length} stories, ${pending.length} pending${flags.has('--force') ? ' (forced)' : ''}; doing ${targets.length} now.`);
  if (!targets.length) {
    console.log('RETRANSCRIBE_SUMMARY done=0 failed=0 remaining=0');
    process.exit(0);
  }
}

const keyterms = loadKeyterms();
console.log(
  `Keyterms: ${keyterms.terms.length} (${keyterms.characters} characters, ${keyterms.places} places)` +
    (keyterms.dropped.length ? `; ${keyterms.dropped.length} names not sendable/over the cap` : ''),
);

// ---- run ----
let done = 0;
let failed = 0;
let consecutiveFailures = 0;
let totalCost = 0;
const lowConfidence: string[] = [];
const unanchored: string[] = [];

for (const [i, slug] of targets.entries()) {
  const audioPath = path.join(CONTENT_STORIES_DIR, slug, 'source.m4a');
  const record = readStory(slug);
  const prefix = targets.length > 1 ? `[${i + 1}/${targets.length}] ` : '';
  if (!fs.existsSync(audioPath)) {
    console.warn(`${prefix}${slug}: source.m4a is not on this machine — skipped.`);
    failed++;
    continue;
  }
  console.log(`\n${prefix}Re-transcribing "${record.title}" (${slug})...`);
  const old = { lines: record.transcript.length, izzy: record.izzyWordCount, dad: record.dadWordCount };

  let result;
  try {
    result = await runEngine(ARCHIVE_ENGINE, audioPath, {
      keyterms: keyterms.terms,
      referenceTranscript: record.transcript,
      durationSec: await audioDurationSec(audioPath),
      rawDumpDir: path.join(CONTENT_BAKEOFF_DIR, `retranscribe-${slug}`), // gitignored scratch
    });
  } catch (e: any) {
    if (e instanceof QuotaExceededError) {
      console.error(`\n${e.message}`);
      console.error(`Stopping: ${done} story(ies) re-transcribed in this run before the quota ran out.`);
      console.log(`RETRANSCRIBE_SUMMARY done=${done} failed=${failed} remaining=${targets.length - i} quota=exceeded`);
      process.exit(3);
    }
    failed++;
    consecutiveFailures++;
    console.error(`  FAILED: ${e?.message || e}`);
    if (consecutiveFailures >= 3) {
      console.error('Three failures in a row — stopping (network or API trouble?).');
      console.log(`RETRANSCRIBE_SUMMARY done=${done} failed=${failed} remaining=${targets.length - i}`);
      process.exit(2);
    }
    continue;
  }
  consecutiveFailures = 0;

  console.log(`  speakers: ${describeMapping(result)}`);
  if (result.speakerMapConfidence === 'low') lowConfidence.push(slug);
  const fixes = Object.entries(result.spellingFixes);
  if (fixes.length) console.log(`  spelling fixes: ${fixes.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  const oddSpeakers = [...new Set(result.transcript.map((t) => t.speaker))].filter((s) => s !== 'Dad' && s !== 'Izzy');
  if (oddSpeakers.length) {
    console.warn(`  WARNING: unexpected speaker label(s) ${oddSpeakers.join(', ')} — their words are outside the Izzy/Dad counts.`);
  }

  record.transcript = result.transcript;
  Object.assign(record, computeWordCounts(result.transcript));
  record.transcription = {
    engine: result.engine,
    model: result.model,
    keyterms: result.keytermCount,
    at: new Date().toISOString(),
    speakerMap: result.rawSpeakerMap,
    speakerMapMethod: result.speakerMapMethod,
    speakerMapConfidence: result.speakerMapConfidence,
  };

  // The quote's text is kept; its timestamp is re-located against the new
  // transcript, falling back to the old one (same audio, same timeline).
  if (record.highlightQuote?.text) {
    const recovered = recoverQuoteTimestamp(record.highlightQuote.text, result.transcript);
    if (recovered == null) {
      unanchored.push(slug);
      console.log('  quote: no longer matches a transcript line verbatim — keeping its previous timestamp.');
    } else {
      record.highlightQuote = { text: record.highlightQuote.text, timestamp: recovered };
    }
  }

  fs.writeFileSync(storyJsonPath(slug), JSON.stringify(record, null, 2));
  done++;
  if (result.estimatedCostUsd != null) totalCost += result.estimatedCostUsd;
  console.log(
    `  transcript: ${old.lines} -> ${record.transcript.length} lines, Izzy ${old.izzy} -> ${record.izzyWordCount} words, Dad ${old.dad} -> ${record.dadWordCount} words` +
      (result.estimatedCostUsd != null ? `  (~$${result.estimatedCostUsd.toFixed(3)}, ${(result.elapsedMs / 1000).toFixed(0)}s)` : ''),
  );
}

// ---- summary ----
console.log(`\nRe-transcribed ${done} story(ies)${failed ? `, ${failed} failed/skipped` : ''}${totalCost ? `; estimated cost ~$${totalCost.toFixed(2)}` : ''}.`);
if (lowConfidence.length) {
  console.log(`Low-confidence speaker mappings (check Dad/Izzy in these):\n  ${lowConfidence.join('\n  ')}`);
}
if (unanchored.length) {
  console.log(`Highlight quotes that no longer match a line verbatim (kept with their old timestamp):\n  ${unanchored.join('\n  ')}`);
}
let remaining = 0;
if (all) {
  remaining = fs
    .readdirSync(CONTENT_STORIES_DIR)
    .filter((s) => fs.existsSync(storyJsonPath(s)))
    .filter((s) => !isDone(readStory(s))).length;
  console.log(`Remaining: ${remaining} story(ies) still to re-transcribe.`);
}
if (done && !flags.has('--no-build')) {
  console.log('Rebuilding site bundle...');
  await buildSite();
}
console.log(`Review: git diff --stat ${path.relative(ROOT, CONTENT_STORIES_DIR)}`);
console.log(`RETRANSCRIBE_SUMMARY done=${done} failed=${failed} remaining=${remaining}`);
