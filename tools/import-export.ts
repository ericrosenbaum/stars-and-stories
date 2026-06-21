/**
 * One-time migration: the AI Studio data export -> the canonical `content/` dataset.
 * Does NOT use Gemini. Re-runnable (overwrites content/).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  findExportDir,
  CONTENT_STORIES_DIR,
  CONTENT_CHARACTERS,
  CONTENT_PLACES,
  CONTENT_MANIFEST,
  ensureDir,
} from './lib/paths.ts';
import { computeWordCounts } from './lib/wordcount.ts';
import { recoverQuoteTimestamp } from './lib/quote.ts';
import { recomputeEntityLinks } from './lib/entities.ts';
import { sha256File } from './lib/media.ts';
import type { StoryRecord, ManifestEntry, EmbeddedEntity, HighlightQuote } from './lib/types.ts';

const exportDir = findExportDir();
const exportStoriesDir = path.join(exportDir, 'stories');
console.log(`Importing from ${exportDir}`);

const topChars = JSON.parse(fs.readFileSync(path.join(exportDir, 'characters.json'), 'utf8'));
const topPlaces = JSON.parse(fs.readFileSync(path.join(exportDir, 'places.json'), 'utf8'));

ensureDir(CONTENT_STORIES_DIR);

const folders = fs
  .readdirSync(exportStoriesDir)
  .filter((f) => fs.statSync(path.join(exportStoriesDir, f)).isDirectory());

const stories: StoryRecord[] = [];
const manifest: Record<string, ManifestEntry> = {};

for (const folder of folders) {
  const dir = path.join(exportStoriesDir, folder);
  const storyJsonPath = path.join(dir, 'story.json');
  if (!fs.existsSync(storyJsonPath)) {
    console.warn(`  skip (no story.json): ${folder}`);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(storyJsonPath, 'utf8'));
  const slug = folder;
  const transcript = Array.isArray(raw.transcript) ? raw.transcript : [];
  const counts = computeWordCounts(transcript);

  // highlightQuote: the export stores a bare string; recover a timestamp.
  let highlightQuote: HighlightQuote | null = null;
  if (typeof raw.highlightQuote === 'string' && raw.highlightQuote.trim()) {
    highlightQuote = {
      text: raw.highlightQuote.trim(),
      timestamp: recoverQuoteTimestamp(raw.highlightQuote, transcript),
    };
  } else if (raw.highlightQuote && typeof raw.highlightQuote === 'object' && raw.highlightQuote.text) {
    highlightQuote = {
      text: raw.highlightQuote.text,
      timestamp:
        typeof raw.highlightQuote.timestamp === 'number'
          ? raw.highlightQuote.timestamp
          : recoverQuoteTimestamp(raw.highlightQuote.text, transcript),
    };
  }

  const characters: EmbeddedEntity[] = (raw.characters || [])
    .filter((c: any) => c && c.id)
    .map((c: any) => ({ id: c.id, name: c.name, description: c.description || '' }));
  const places: EmbeddedEntity[] = (raw.places || [])
    .filter((p: any) => p && p.id)
    .map((p: any) => ({ id: p.id, name: p.name, description: p.description || '' }));

  const record: StoryRecord = {
    id: slug,
    title: raw.title || slug,
    date: raw.date,
    summary: raw.summary || '',
    audioFilename: raw.audioFilename || '',
    highlightQuote,
    transcript,
    characters,
    places,
    ...counts,
  };

  const destDir = path.join(CONTENT_STORIES_DIR, slug);
  ensureDir(destDir);

  let audioHash = '';
  const audioSrc = raw.audioFilename ? path.join(dir, raw.audioFilename) : null;
  if (audioSrc && fs.existsSync(audioSrc)) {
    const destAudio = path.join(destDir, 'source.m4a');
    fs.copyFileSync(audioSrc, destAudio);
    audioHash = sha256File(destAudio);
  } else {
    console.warn(`  missing audio for ${slug}: ${raw.audioFilename}`);
  }

  const headerSrc = path.join(dir, 'header.png');
  if (fs.existsSync(headerSrc)) {
    fs.copyFileSync(headerSrc, path.join(destDir, 'source.png'));
  } else {
    console.warn(`  missing header.png for ${slug}`);
  }

  fs.writeFileSync(path.join(destDir, 'story.json'), JSON.stringify(record, null, 2));
  stories.push(record);
  manifest[slug] = { audioHash, sourceFilename: raw.audioFilename || '', date: raw.date };
}

const canonChars = recomputeEntityLinks(
  topChars.map((c: any) => ({ id: c.id, name: c.name, description: c.description || '' })),
  stories,
  'characters',
);
const canonPlaces = recomputeEntityLinks(
  topPlaces.map((p: any) => ({ id: p.id, name: p.name, description: p.description || '' })),
  stories,
  'places',
);

fs.writeFileSync(CONTENT_CHARACTERS, JSON.stringify(canonChars, null, 2));
fs.writeFileSync(CONTENT_PLACES, JSON.stringify(canonPlaces, null, 2));
fs.writeFileSync(CONTENT_MANIFEST, JSON.stringify(manifest, null, 2));

const withQuote = stories.filter((s) => s.highlightQuote).length;
const withTs = stories.filter((s) => s.highlightQuote && s.highlightQuote.timestamp != null).length;
console.log(`\nImported ${stories.length} stories, ${canonChars.length} characters, ${canonPlaces.length} places.`);
console.log(`Highlight quotes: ${withQuote} present, ${withTs} with recovered timestamps.`);
console.log(`Next: \`npm run build\` (and optionally \`npm run world-dna\`).`);
