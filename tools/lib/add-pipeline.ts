/**
 * The add-story pipeline as an importable function, shared by the CLI
 * (add-story.ts) and the studio server (studio.ts):
 *
 *   dedupe -> date -> transcribe+analyze (Gemini) -> merge characters/places ->
 *   write content/stories/<slug>/ -> header-image candidates -> rebuild site.
 *
 * The story is fully persisted BEFORE candidate generation, so a failure or
 * interruption there just leaves the story header-less until a candidate is
 * selected — never a half-written story.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CONTENT_STORIES_DIR,
  CONTENT_CHARACTERS,
  CONTENT_PLACES,
  CONTENT_MANIFEST,
  ensureDir,
} from './paths.ts';
import { sha256File } from './media.ts';
import { computeWordCounts } from './wordcount.ts';
import { recoverQuoteTimestamp } from './quote.ts';
import { uniqueSlug } from './slug.ts';
import { recomputeEntityLinks } from './entities.ts';
import { generateHeaderCandidates, type CandidateSet } from './candidates.ts';
import { transcribeAndAnalyze, mergeEntityDescription } from './gemini.ts';
import { buildSite } from '../build-site.ts';
import type { StoryRecord, EmbeddedEntity, CanonicalEntity, ManifestEntry, HighlightQuote } from './types.ts';

export type Stage = 'date' | 'transcribe' | 'entities' | 'write' | 'candidates' | 'build' | 'done';
export type ProgressFn = (stage: Stage, message: string) => void;

export class DuplicateAudioError extends Error {
  constructor(
    public slug: string,
    public reason: 'hash' | 'filename',
    message: string,
  ) {
    super(message);
    this.name = 'DuplicateAudioError';
  }
}

export interface AddStoryOptions {
  /** Override the story date (YYYY-MM-DD). */
  date?: string;
  /** Generate header-image candidates (default true). */
  generateImage?: boolean;
  /** Rebuild the site bundle afterwards (default true). */
  build?: boolean;
  /** Merge new entity descriptions into existing ones via Gemini. */
  mergeDescriptions?: boolean;
  /**
   * The audio's original filename. Uploads land in a tmp dir under a random
   * name, but dedupe-by-filename and record.audioFilename must use the name
   * the user knows. Defaults to basename(audioPath).
   */
  sourceFilename?: string;
  /**
   * Last-resort date fallback (epoch ms) replacing the file's mtime — for
   * uploads, whose tmp-file mtime is the upload time, not the recording time
   * (the browser supplies File.lastModified instead).
   */
  fallbackMtime?: number;
  onProgress?: ProgressFn;
}

export interface AddStoryResult {
  slug: string;
  record: StoryRecord;
  candidates: CandidateSet | null;
  /** Candidate generation failure is non-fatal; the message lands here. */
  candidatesError?: string;
}

function readManifest(): Record<string, ManifestEntry> {
  return fs.existsSync(CONTENT_MANIFEST) ? JSON.parse(fs.readFileSync(CONTENT_MANIFEST, 'utf8')) : {};
}

/**
 * Throws DuplicateAudioError if this audio (by content hash or original
 * filename) is already in the archive. Cheap — no Gemini calls — so callers
 * can reject duplicates before any API spend.
 */
export function checkDuplicate(audioPath: string, sourceFilename?: string): void {
  const filename = sourceFilename ?? path.basename(audioPath);
  const manifest = readManifest();
  const audioHash = sha256File(audioPath);
  for (const [slug, m] of Object.entries(manifest)) {
    if (m.audioHash === audioHash) {
      throw new DuplicateAudioError(slug, 'hash', `This audio is already in the archive as "${slug}" (matching hash).`);
    }
    if (m.sourceFilename && m.sourceFilename === filename) {
      throw new DuplicateAudioError(slug, 'filename', `A story with source filename "${filename}" already exists ("${slug}").`);
    }
  }
}

async function deriveDate(
  audioPath: string,
  sourceFilename: string,
  dateOverride?: string,
  fallbackMtime?: number,
): Promise<string> {
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
  if (fallbackMtime) return new Date(fallbackMtime).toISOString();
  return fs.statSync(audioPath).mtime.toISOString();
}

const norm = (s: string) => (s || '').toLowerCase().trim();
function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

async function mergeEntities(
  extracted: { name: string; description: string }[],
  canonicalPath: string,
  mergeDescriptions: boolean,
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
      if (mergeDescriptions && ex.description) {
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

export async function addStory(audioPath: string, opts: AddStoryOptions = {}): Promise<AddStoryResult> {
  const progress: ProgressFn = opts.onProgress ?? (() => {});
  const sourceFilename = opts.sourceFilename ?? path.basename(audioPath);

  checkDuplicate(audioPath, sourceFilename);
  const audioHash = sha256File(audioPath);
  const manifest = readManifest();

  const date = await deriveDate(audioPath, sourceFilename, opts.date, opts.fallbackMtime);
  progress('date', `Date: ${date.split('T')[0]}`);

  progress('transcribe', 'Transcribing + analyzing with Gemini (this can take a minute)...');
  const audioBuf = fs.readFileSync(audioPath);
  const analysis = await transcribeAndAnalyze(audioBuf.toString('base64'), 'audio/mp4');
  progress(
    'entities',
    `Title: "${analysis.title}"  (${analysis.transcript.length} lines, ${analysis.characters.length} characters, ${analysis.places.length} places)`,
  );

  const existingSlugs = new Set(fs.existsSync(CONTENT_STORIES_DIR) ? fs.readdirSync(CONTENT_STORIES_DIR) : []);
  const slug = uniqueSlug(analysis.title, (s) => existingSlugs.has(s) || !!manifest[s]);
  const destDir = path.join(CONTENT_STORIES_DIR, slug);
  ensureDir(destDir);

  // merge entities (writes nothing yet)
  const charMerge = await mergeEntities(analysis.characters, CONTENT_CHARACTERS, !!opts.mergeDescriptions);
  const placeMerge = await mergeEntities(analysis.places, CONTENT_PLACES, !!opts.mergeDescriptions);

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

  progress('write', `Saving story files for "${analysis.title}"...`);

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

  progress('write', `Added "${analysis.title}" as ${slug}.`);

  // header-image candidates (the story is already fully persisted, so a failure
  // here — or an interrupted run — just leaves the story header-less until a
  // candidate is selected)
  let candidates: CandidateSet | null = null;
  let candidatesError: string | undefined;
  if (opts.generateImage !== false) {
    try {
      progress('candidates', 'Generating header-image candidates with Gemini...');
      candidates = await generateHeaderCandidates(slug, record);
    } catch (e: any) {
      candidatesError = e?.message || String(e);
      console.warn(`  candidate generation failed (${candidatesError}); continuing without a header.`);
      console.warn(`  You can retry later with: npm run regen-image -- ${slug}`);
    }
  }

  if (opts.build !== false) {
    progress('build', 'Rebuilding site bundle...');
    await buildSite();
  }

  progress('done', 'Done.');
  return { slug, record, candidates, candidatesError };
}
