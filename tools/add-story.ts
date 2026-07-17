/**
 * Add a story from an iOS voice memo (.m4a):
 *   npx tsx add-story.ts <path-to.m4a> [options]
 *
 * Options:
 *   --date YYYY-MM-DD     override the story date
 *   --engine <id>        transcription engine (default: scribe-v2; also
 *                        gemini-flash | gemini-pro | openai-diarize)
 *   --no-image           skip header-image candidate generation
 *   --no-build           don't rebuild the site bundle afterwards
 *   --world-dna          also regenerate the World DNA essay
 *   --merge-descriptions use Gemini to merge descriptions of existing entities
 *
 * Pipeline: dedupe -> transcribe (default: ElevenLabs scribe-v2) -> analyze
 * (Gemini: title/entities/summary/quote) -> merge characters/places -> write
 * content/stories/<slug>/ -> header-image candidates (Gemini) -> rebuild site.
 *
 * The story is published WITHOUT a header image at first: three candidate
 * images are generated for review, and the header is finalized afterwards with
 * `npm run regen-image -- <slug> --select <n>`.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CONTENT_STORIES_DIR,
  CONTENT_CHARACTERS,
  CONTENT_PLACES,
  CONTENT_MANIFEST,
  CONTENT_BAKEOFF_DIR,
  ensureDir,
} from './lib/paths.ts';
import { sha256File } from './lib/media.ts';
import { computeWordCounts } from './lib/wordcount.ts';
import { recoverQuoteTimestamp } from './lib/quote.ts';
import { uniqueSlug } from './lib/slug.ts';
import { recomputeEntityLinks } from './lib/entities.ts';
import { generateHeaderCandidates } from './lib/candidates.ts';
import { analyzeTranscript, mergeEntityDescription } from './lib/gemini.ts';
import { ALL_ENGINES, audioDurationSec, defaultEngine, runEngine, type EngineId } from './lib/asr.ts';
import { loadNameLexicon } from './lib/lexicon.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord, EmbeddedEntity, CanonicalEntity, ManifestEntry, HighlightQuote } from './lib/types.ts';

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dateFlagIdx = args.indexOf('--date');
const dateOverride = dateFlagIdx >= 0 ? args[dateFlagIdx + 1] : null;
const engineFlagIdx = args.indexOf('--engine');
const engine = (engineFlagIdx >= 0 ? args[engineFlagIdx + 1] : defaultEngine()) as EngineId;
// Exclude the --date/--engine values so the audio path is found regardless of order.
const dateValIdx = dateFlagIdx >= 0 ? dateFlagIdx + 1 : -1;
const engineValIdx = engineFlagIdx >= 0 ? engineFlagIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== dateValIdx && i !== engineValIdx);
const audioPath = positional[0];

if (!audioPath) {
  console.error('Usage: npx tsx add-story.ts <path-to.m4a> [--date YYYY-MM-DD] [--engine <id>] [--no-image] [--no-build] [--world-dna] [--merge-descriptions]');
  process.exit(1);
}
if (!fs.existsSync(audioPath)) {
  console.error(`File not found: ${audioPath}`);
  process.exit(1);
}
if (!ALL_ENGINES.includes(engine)) {
  console.error(`Unknown engine "${engine}". Engines: ${ALL_ENGINES.join(', ')}`);
  process.exit(1);
}

const sourceFilename = path.basename(audioPath);

// ---- dedupe ----
const manifest: Record<string, ManifestEntry> = fs.existsSync(CONTENT_MANIFEST)
  ? JSON.parse(fs.readFileSync(CONTENT_MANIFEST, 'utf8'))
  : {};
const audioHash = sha256File(audioPath);
for (const [slug, m] of Object.entries(manifest)) {
  if (m.audioHash === audioHash) {
    console.error(`This audio is already in the archive as "${slug}" (matching hash). Aborting.`);
    process.exit(1);
  }
  if (m.sourceFilename && m.sourceFilename === sourceFilename) {
    console.error(`A story with source filename "${sourceFilename}" already exists ("${slug}"). Aborting.`);
    process.exit(1);
  }
}

// ---- date ----
async function deriveDate(): Promise<string> {
  if (dateOverride) return new Date(`${dateOverride}T00:00:00Z`).toISOString();
  const m = sourceFilename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).toISOString();
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(audioPath);
    const tagDate =
      (meta.common as any)?.date ||
      (meta.native ? Object.values(meta.native).flat().find((t: any) => /date|creation/i.test(t.id))?.value : null);
    if (tagDate) {
      const d = new Date(tagDate);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  } catch {
    /* best-effort */
  }
  return fs.statSync(audioPath).mtime.toISOString();
}

// ---- entity merge ----
const norm = (s: string) => (s || '').toLowerCase().trim();
function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

async function mergeEntities(
  extracted: { name: string; description: string }[],
  canonicalPath: string,
): Promise<{ embedded: EmbeddedEntity[]; canonical: CanonicalEntity[] }> {
  const canonical: CanonicalEntity[] = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  const byName = new Map<string, CanonicalEntity>();
  for (const e of canonical) byName.set(norm(e.name), e);

  const embedded: EmbeddedEntity[] = [];
  for (const ex of extracted) {
    if (!ex?.name) continue;
    const key = norm(ex.name);
    let entity = byName.get(key);
    if (entity) {
      if (flags.has('--merge-descriptions') && ex.description) {
        try {
          entity.description = await mergeEntityDescription(entity.description, ex.description);
        } catch (e: any) {
          console.warn(`  (description merge failed for "${ex.name}": ${e?.message || e})`);
        }
      }
    } else {
      entity = { id: newId(), name: ex.name, description: ex.description || '', storyIds: [], firstAppearanceStoryId: null };
      canonical.push(entity);
      byName.set(key, entity);
    }
    embedded.push({ id: entity.id, name: entity.name, description: entity.description });
  }
  return { embedded, canonical };
}

// ---- main ----
const date = await deriveDate();
console.log(`Date: ${date.split('T')[0]}`);

console.log(`Transcribing with ${engine} (this can take a minute)...`);
const durationSec = await audioDurationSec(audioPath);
const result = await runEngine(engine, audioPath, {
  lexicon: loadNameLexicon(),
  durationSec,
  // gitignored scratch area, so a raw-response dump on an odd shape can't get committed
  rawDumpDir: path.join(CONTENT_BAKEOFF_DIR, `add-${sourceFilename.replace(/\.[^.]+$/, '')}`),
});
const transcript = result.transcript;
if (result.rawSpeakerMap) {
  const mapStr = Object.entries(result.rawSpeakerMap).map(([k, v]) => `${k} → ${v}`).join(', ');
  console.log(`Speaker mapping (${result.speakerMapMethod}): ${mapStr}`);
}
const oddSpeakers = [...new Set(transcript.map((t) => t.speaker))].filter((s) => s !== 'Dad' && s !== 'Izzy');
if (oddSpeakers.length) {
  console.warn(
    `WARNING: transcript contains unexpected speaker label(s): ${oddSpeakers.join(', ')}.\n` +
      `Their words are excluded from the Izzy/Dad word counts — review story.json before publishing.`,
  );
}

console.log(`  transcript: ${transcript.length} lines. Analyzing with Gemini...`);
const analysis = await analyzeTranscript(transcript);
// The analysis model only copies timestamps from transcript text — anchor the
// highlight quote to the actual transcript line when one matches, since the
// schema forces a numeric timestamp even when the model guesses.
if (analysis.highlightQuote?.text) {
  const recovered = recoverQuoteTimestamp(analysis.highlightQuote.text, transcript);
  if (recovered != null) analysis.highlightQuote.timestamp = recovered;
}
console.log(`Title: "${analysis.title}"  (${transcript.length} lines, ${analysis.characters.length} characters, ${analysis.places.length} places)`);

const existingSlugs = new Set(fs.existsSync(CONTENT_STORIES_DIR) ? fs.readdirSync(CONTENT_STORIES_DIR) : []);
const slug = uniqueSlug(analysis.title, (s) => existingSlugs.has(s) || !!manifest[s]);
const destDir = path.join(CONTENT_STORIES_DIR, slug);
ensureDir(destDir);

// merge entities (writes nothing yet)
const charMerge = await mergeEntities(analysis.characters, CONTENT_CHARACTERS);
const placeMerge = await mergeEntities(analysis.places, CONTENT_PLACES);

// highlight quote (already an object from Gemini, timestamp anchored above)
const highlightQuote: HighlightQuote | null = analysis.highlightQuote?.text
  ? { text: analysis.highlightQuote.text, timestamp: analysis.highlightQuote.timestamp }
  : null;

const counts = computeWordCounts(transcript);
const record: StoryRecord = {
  id: slug,
  title: analysis.title,
  date,
  summary: analysis.summary || '',
  audioFilename: sourceFilename,
  highlightQuote,
  transcript,
  characters: charMerge.embedded,
  places: placeMerge.embedded,
  ...counts,
};

// copy source audio
fs.copyFileSync(audioPath, path.join(destDir, 'source.m4a'));

// write story.json
fs.writeFileSync(path.join(destDir, 'story.json'), JSON.stringify(record, null, 2));

// recompute canonical entity links across ALL stories (incl. the new one)
const allStories: StoryRecord[] = fs
  .readdirSync(CONTENT_STORIES_DIR)
  .filter((s) => fs.existsSync(path.join(CONTENT_STORIES_DIR, s, 'story.json')))
  .map((s) => JSON.parse(fs.readFileSync(path.join(CONTENT_STORIES_DIR, s, 'story.json'), 'utf8')));

const finalChars = recomputeEntityLinks(charMerge.canonical, allStories, 'characters');
const finalPlaces = recomputeEntityLinks(placeMerge.canonical, allStories, 'places');
fs.writeFileSync(CONTENT_CHARACTERS, JSON.stringify(finalChars, null, 2));
fs.writeFileSync(CONTENT_PLACES, JSON.stringify(finalPlaces, null, 2));

// manifest
manifest[slug] = { audioHash, sourceFilename, date };
fs.writeFileSync(CONTENT_MANIFEST, JSON.stringify(manifest, null, 2));

console.log(`\nAdded "${analysis.title}" as ${slug}.`);

// header-image candidates (the story is already fully persisted, so a failure
// here — or an interrupted run — just leaves the story header-less until a
// candidate is selected with `npm run regen-image -- <slug> --select <n>`)
let galleryPath: string | null = null;
if (!flags.has('--no-image')) {
  try {
    console.log('\nGenerating header-image candidates with Gemini...');
    const set = await generateHeaderCandidates(slug, record);
    galleryPath = set.galleryPath;
  } catch (e: any) {
    console.warn(`  candidate generation failed (${e?.message || e}); continuing without a header.`);
    console.warn(`  You can retry later with: npm run regen-image -- ${slug}`);
  }
}

if (!flags.has('--no-build')) {
  console.log('Rebuilding site bundle...');
  await buildSite();
}

if (flags.has('--world-dna')) {
  console.log('Regenerating World DNA...');
  await import('./gen-world-dna.ts');
}

if (galleryPath) {
  console.log(`\nHeader image pending review — the story is published without one until you pick a candidate.`);
  console.log(`  open "${galleryPath}"`);
  console.log(`  npm run regen-image -- ${slug} --select <1|2|3>`);
}
console.log('Done.');
