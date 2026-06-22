/**
 * Add a story from an iOS voice memo (.m4a):
 *   npx tsx add-story.ts <path-to.m4a> [options]
 *
 * Options:
 *   --date YYYY-MM-DD     override the story date
 *   --no-image           skip header-image generation
 *   --no-build           don't rebuild the site bundle afterwards
 *   --world-dna          also regenerate the World DNA essay
 *   --merge-descriptions use Gemini to merge descriptions of existing entities
 *
 * Pipeline: dedupe -> transcribe+analyze (Gemini) -> header image (Gemini) ->
 * merge characters/places -> write content/stories/<slug>/ -> rebuild site.
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
  ensureDir,
} from './lib/paths.ts';
import { sha256File } from './lib/media.ts';
import { computeWordCounts } from './lib/wordcount.ts';
import { recoverQuoteTimestamp } from './lib/quote.ts';
import { uniqueSlug } from './lib/slug.ts';
import { recomputeEntityLinks } from './lib/entities.ts';
import { loadCharacterRefImages } from './lib/refimages.ts';
import { transcribeAndAnalyze, generateStoryHeaderImage, mergeEntityDescription } from './lib/gemini.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord, EmbeddedEntity, CanonicalEntity, ManifestEntry, HighlightQuote } from './lib/types.ts';

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const dateFlagIdx = args.indexOf('--date');
const dateOverride = dateFlagIdx >= 0 ? args[dateFlagIdx + 1] : null;
const audioPath = positional[0];

if (!audioPath) {
  console.error('Usage: npx tsx add-story.ts <path-to.m4a> [--date YYYY-MM-DD] [--no-image] [--no-build] [--world-dna] [--merge-descriptions]');
  process.exit(1);
}
if (!fs.existsSync(audioPath)) {
  console.error(`File not found: ${audioPath}`);
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

console.log('Transcribing + analyzing with Gemini (this can take a minute)...');
const audioBuf = fs.readFileSync(audioPath);
const analysis = await transcribeAndAnalyze(audioBuf.toString('base64'), 'audio/mp4');
console.log(`Title: "${analysis.title}"  (${analysis.transcript.length} lines, ${analysis.characters.length} characters, ${analysis.places.length} places)`);

const existingSlugs = new Set(fs.existsSync(CONTENT_STORIES_DIR) ? fs.readdirSync(CONTENT_STORIES_DIR) : []);
const slug = uniqueSlug(analysis.title, (s) => existingSlugs.has(s) || !!manifest[s]);
const destDir = path.join(CONTENT_STORIES_DIR, slug);
ensureDir(destDir);

// merge entities (writes nothing yet)
const charMerge = await mergeEntities(analysis.characters, CONTENT_CHARACTERS);
const placeMerge = await mergeEntities(analysis.places, CONTENT_PLACES);

// highlight quote (already an object from Gemini; ensure timestamp)
let highlightQuote: HighlightQuote | null = null;
if (analysis.highlightQuote?.text) {
  highlightQuote = {
    text: analysis.highlightQuote.text,
    timestamp:
      typeof analysis.highlightQuote.timestamp === 'number'
        ? analysis.highlightQuote.timestamp
        : recoverQuoteTimestamp(analysis.highlightQuote.text, analysis.transcript),
  };
}

const counts = computeWordCounts(analysis.transcript);
const record: StoryRecord = {
  id: slug,
  title: analysis.title,
  date,
  summary: analysis.summary || '',
  audioFilename: sourceFilename,
  highlightQuote,
  transcript: analysis.transcript,
  characters: charMerge.embedded,
  places: placeMerge.embedded,
  ...counts,
};

// copy source audio
fs.copyFileSync(audioPath, path.join(destDir, 'source.m4a'));

// header image
if (!flags.has('--no-image')) {
  try {
    console.log('Generating header image with Gemini...');
    const refImages = loadCharacterRefImages(charMerge.embedded);
    if (refImages.length) {
      console.log(`  using ${refImages.length} character reference image(s): ${refImages.map((r) => r.name).join(', ')}`);
    }
    const dataUrl = await generateStoryHeaderImage(analysis.summary, analysis.transcript, refImages);
    if (dataUrl) {
      const b64 = dataUrl.split(',')[1];
      fs.writeFileSync(path.join(destDir, 'source.png'), Buffer.from(b64, 'base64'));
      console.log('  header image saved.');
    } else {
      console.warn('  image model returned nothing; story will have no header image.');
    }
  } catch (e: any) {
    console.warn(`  header image generation failed (${e?.message || e}); continuing without one.`);
  }
}

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

if (!flags.has('--no-build')) {
  console.log('Rebuilding site bundle...');
  await buildSite();
}

if (flags.has('--world-dna')) {
  console.log('Regenerating World DNA...');
  await import('./gen-world-dna.ts');
}

console.log('Done.');
