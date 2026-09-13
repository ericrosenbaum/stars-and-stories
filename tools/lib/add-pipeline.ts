/**
 * The add-story pipeline, in two halves so that the Claude Code agent driving
 * the tools — not an LLM API — does the reading and writing:
 *
 *   1. transcribeDraft(audio)   dedupe -> date -> ElevenLabs Scribe (complete
 *      keyterm list, spelling normalization, Dad/Izzy mapping) ->
 *      content/drafts/<id>/{source.m4a, draft.json, transcript.txt}
 *   2. the agent reads transcript.txt and writes content/drafts/<id>/analysis.json
 *      (title, summary, characters, places, highlight quote, header prompts)
 *   3. finalizeStory(id)        validate analysis -> slug -> content/stories/<slug>/
 *      -> merge characters/places (alias-aware) -> manifest -> site bundle ->
 *      header-image candidates from analysis.headerPrompts (the Gemini image model)
 *
 * The story is fully persisted BEFORE candidate generation, so a failure or
 * interruption there just leaves the story header-less until a candidate is
 * selected — never a half-written story. Drafts are local flow state
 * (gitignored) and are deleted when finalized.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ROOT,
  CONTENT_STORIES_DIR,
  CONTENT_CHARACTERS,
  CONTENT_PLACES,
  CONTENT_MANIFEST,
  CONTENT_BAKEOFF_DIR,
  CONTENT_DRAFTS_DIR,
  ensureDir,
} from './paths.ts';
import { sha256File } from './media.ts';
import { computeWordCounts } from './wordcount.ts';
import { recoverQuoteTimestamp } from './quote.ts';
import { uniqueSlug } from './slug.ts';
import { recomputeEntityLinks } from './entities.ts';
import { generateHeaderCandidates, type CandidateSet } from './candidates.ts';
import { ARCHIVE_ENGINE, audioDurationSec, describeMapping, runEngine } from './asr.ts';
import { loadCharacterRefImages } from './refimages.ts';
import { headerPromptBrief } from './prompt-guide.ts';
import { buildSite } from '../build-site.ts';
import type {
  StoryRecord,
  TranscriptItem,
  EmbeddedEntity,
  CanonicalEntity,
  ManifestEntry,
  HighlightQuote,
  DraftRecord,
  StoryAnalysis,
} from './types.ts';

export type Stage = 'date' | 'transcribe' | 'write' | 'entities' | 'candidates' | 'build' | 'done';
export type ProgressFn = (stage: Stage, message: string) => void;

export class DuplicateAudioError extends Error {
  constructor(
    public slug: string,
    public reason: 'hash' | 'filename' | 'draft',
    message: string,
  ) {
    super(message);
    this.name = 'DuplicateAudioError';
  }
}

function readManifest(): Record<string, ManifestEntry> {
  return fs.existsSync(CONTENT_MANIFEST) ? JSON.parse(fs.readFileSync(CONTENT_MANIFEST, 'utf8')) : {};
}

const draftDir = (id: string) => path.join(CONTENT_DRAFTS_DIR, id);
const draftJsonPath = (id: string) => path.join(draftDir(id), 'draft.json');
export const analysisPath = (id: string) => path.join(draftDir(id), 'analysis.json');
const rel = (p: string) => path.relative(ROOT, p);

function draftIds(): string[] {
  if (!fs.existsSync(CONTENT_DRAFTS_DIR)) return [];
  return fs.readdirSync(CONTENT_DRAFTS_DIR).filter((d) => fs.existsSync(draftJsonPath(d)));
}

export function readDraft(id: string): DraftRecord {
  const p = draftJsonPath(id);
  if (!fs.existsSync(p)) {
    const ids = draftIds();
    throw new Error(`No draft "${id}" under ${rel(CONTENT_DRAFTS_DIR)}/.${ids.length ? ` Drafts: ${ids.join(', ')}` : ''}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Throws DuplicateAudioError if this audio (by content hash or original
 * filename) is already in the archive or sitting in a draft. Cheap — no API
 * calls — so callers can reject duplicates before any spend.
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
  for (const id of draftIds()) {
    const d = readDraft(id);
    if (d.audioHash === audioHash || d.sourceFilename === filename) {
      throw new DuplicateAudioError(
        id,
        'draft',
        `This recording is already transcribed as draft "${id}" — write its analysis.json and run: npm run finalize -- ${id}`,
      );
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

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A human-readable transcript for the agent to read (draft.json keeps the data). */
export function transcriptText(draft: DraftRecord): string {
  const head = [
    `# ${draft.sourceFilename}  (${draft.date.slice(0, 10)})`,
    `# ${draft.transcript.length} lines · Izzy ${draft.izzyWordCount} words · Dad ${draft.dadWordCount} words`,
    `# speakers: ${JSON.stringify(draft.transcription.speakerMap ?? {})} via ${draft.transcription.speakerMapMethod} (${draft.transcription.speakerMapConfidence} confidence)`,
    Object.keys(draft.spellingFixes).length ? `# spelling fixes applied: ${JSON.stringify(draft.spellingFixes)}` : '# spelling fixes applied: none',
    '',
  ];
  const lines = draft.transcript.map((t) => `[${fmtTime(t.timestamp)}] ${t.speaker}: ${t.text}`);
  return [...head, ...lines].join('\n') + '\n';
}

export function nextStepsFor(id: string, draft: DraftRecord): string[] {
  const conf = draft.transcription.speakerMapConfidence;
  return [
    `Read ${rel(path.join(draftDir(id), 'transcript.txt'))}${conf === 'low' ? ' — CHECK the Dad/Izzy labels (low-confidence mapping); set "swapSpeakers": true in the analysis if they are backwards' : ''}.`,
    `Write ${rel(analysisPath(id))}: { "title", "summary", "characters": [{ "name", "description" }], "places": [...], "highlightQuote": { "text" }, "headerPrompts": [3 prompts] } — reuse canonical names from content/characters.json (aliases count) and copy the quote verbatim from an Izzy line.`,
    `npm run finalize -- ${id} --dry-run   (shows which characters/places are new), then without --dry-run.`,
  ];
}

// ---------------------------------------------------------------------------
// Step 1: audio -> draft
// ---------------------------------------------------------------------------

export interface TranscribeDraftOptions {
  /** Override the story date (YYYY-MM-DD). */
  date?: string;
  /**
   * The audio's original filename. Uploads land in a tmp dir under a random
   * name, but dedupe-by-filename and the story's audioFilename must use the
   * name the user knows. Defaults to basename(audioPath).
   */
  sourceFilename?: string;
  /**
   * Last-resort date fallback (epoch ms) replacing the file's mtime — for
   * uploads, whose tmp-file mtime is the upload time, not the recording time.
   */
  fallbackMtime?: number;
  onProgress?: ProgressFn;
}

export interface DraftResult {
  id: string;
  dir: string;
  draft: DraftRecord;
  nextSteps: string[];
}

export async function transcribeDraft(audioPath: string, opts: TranscribeDraftOptions = {}): Promise<DraftResult> {
  const progress: ProgressFn = opts.onProgress ?? (() => {});
  const sourceFilename = opts.sourceFilename ?? path.basename(audioPath);

  checkDuplicate(audioPath, sourceFilename);
  const audioHash = sha256File(audioPath);
  const date = await deriveDate(audioPath, sourceFilename, opts.date, opts.fallbackMtime);
  progress('date', `Date: ${date.split('T')[0]}`);

  const base = sourceFilename.replace(/\.[^.]+$/, '');
  const taken = new Set([...draftIds(), ...(fs.existsSync(CONTENT_STORIES_DIR) ? fs.readdirSync(CONTENT_STORIES_DIR) : [])]);
  const id = uniqueSlug(base, (s) => taken.has(s));

  progress('transcribe', `Transcribing with ElevenLabs Scribe (this can take a minute)...`);
  const durationSec = await audioDurationSec(audioPath);
  const result = await runEngine(ARCHIVE_ENGINE, audioPath, {
    durationSec,
    // gitignored scratch area, so a raw-response dump on an odd shape can't get committed
    rawDumpDir: path.join(CONTENT_BAKEOFF_DIR, `add-${id}`),
  });
  progress('transcribe', `Transcript: ${result.transcript.length} lines · ${result.keytermCount} keyterms sent · speakers ${describeMapping(result)}`);
  const fixes = Object.entries(result.spellingFixes);
  if (fixes.length) progress('transcribe', `Spelling fixes: ${fixes.map(([k, v]) => `${k} ×${v}`).join(', ')}`);

  const draft: DraftRecord = {
    id,
    sourceFilename,
    audioHash,
    date,
    createdAt: new Date().toISOString(),
    durationSec,
    transcript: result.transcript,
    transcription: {
      engine: result.engine,
      model: result.model,
      keyterms: result.keytermCount,
      at: new Date().toISOString(),
      speakerMap: result.rawSpeakerMap,
      speakerMapMethod: result.speakerMapMethod,
      speakerMapConfidence: result.speakerMapConfidence,
    },
    spellingFixes: result.spellingFixes,
    ...result.counts,
  };

  progress('write', `Saving draft ${id}...`);
  const dir = draftDir(id);
  ensureDir(dir);
  fs.copyFileSync(audioPath, path.join(dir, 'source.m4a'));
  fs.writeFileSync(draftJsonPath(id), JSON.stringify(draft, null, 2));
  fs.writeFileSync(path.join(dir, 'transcript.txt'), transcriptText(draft));

  const nextSteps = nextStepsFor(id, draft);
  progress('done', `Draft saved to ${rel(dir)}/ — awaiting analysis.`);
  return { id, dir, draft, nextSteps };
}

// ---------------------------------------------------------------------------
// Drafts listing (CLI + studio)
// ---------------------------------------------------------------------------

export interface DraftSummary {
  id: string;
  sourceFilename: string;
  date: string;
  createdAt: string;
  lines: number;
  izzyWordCount: number;
  dadWordCount: number;
  speakerMapConfidence?: 'high' | 'low';
  hasAnalysis: boolean;
  nextSteps: string[];
}

export function listDrafts(): DraftSummary[] {
  return draftIds()
    .map((id) => {
      const d = readDraft(id);
      return {
        id,
        sourceFilename: d.sourceFilename,
        date: d.date,
        createdAt: d.createdAt,
        lines: d.transcript.length,
        izzyWordCount: d.izzyWordCount,
        dadWordCount: d.dadWordCount,
        speakerMapConfidence: d.transcription?.speakerMapConfidence,
        hasAnalysis: fs.existsSync(analysisPath(id)),
        nextSteps: nextStepsFor(id, d),
      };
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// ---------------------------------------------------------------------------
// Step 3: draft + analysis -> story
// ---------------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Load and validate content/drafts/<id>/analysis.json; throws listing every problem. */
export function readAnalysis(id: string): StoryAnalysis {
  const p = analysisPath(id);
  if (!fs.existsSync(p)) throw new Error(`No analysis yet: write ${rel(p)} first (see npm run finalize -- --list).`);
  let a: any;
  try {
    a = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e: any) {
    throw new Error(`${rel(p)} is not valid JSON: ${e?.message || e}`);
  }
  const problems: string[] = [];
  if (!isStr(a?.title) || !a.title.trim()) problems.push('"title" must be a non-empty string');
  else if (a.title.length > 160) problems.push('"title" is over 160 characters');
  if (!isStr(a?.summary) || !a.summary.trim()) problems.push('"summary" must be a non-empty string');
  else if (a.summary.length > 1500) problems.push('"summary" is over 1500 characters');
  for (const field of ['characters', 'places'] as const) {
    if (!Array.isArray(a?.[field])) problems.push(`"${field}" must be an array (use [] for none)`);
    else {
      a[field].forEach((e: any, i: number) => {
        if (!isStr(e?.name) || !e.name.trim()) problems.push(`"${field}[${i}].name" must be a non-empty string`);
        if (!isStr(e?.description)) problems.push(`"${field}[${i}].description" must be a string`);
      });
      const names = a[field].map((e: any) => String(e?.name ?? '').trim().toLowerCase());
      const dup = names.find((n: string, i: number) => n && names.indexOf(n) !== i);
      if (dup) problems.push(`"${field}" lists "${dup}" twice`);
    }
  }
  if (a?.highlightQuote != null) {
    if (!isStr(a.highlightQuote?.text) || !a.highlightQuote.text.trim()) problems.push('"highlightQuote.text" must be a non-empty string (or set highlightQuote to null)');
    else if (a.highlightQuote.text.length > 500) problems.push('"highlightQuote.text" is over 500 characters');
  }
  if (a?.headerPrompts != null) {
    if (!Array.isArray(a.headerPrompts) || !a.headerPrompts.length || !a.headerPrompts.every((s: unknown) => isStr(s) && s.trim())) {
      problems.push('"headerPrompts" must be a non-empty array of strings (or omit it)');
    }
  }
  if (a?.swapSpeakers != null && typeof a.swapSpeakers !== 'boolean') problems.push('"swapSpeakers" must be true/false');
  if (problems.length) throw new Error(`${rel(p)} has problems:\n  - ${problems.join('\n  - ')}`);
  return {
    title: a.title.trim(),
    summary: a.summary.trim(),
    characters: a.characters.map((e: any) => ({ name: e.name.trim(), description: (e.description || '').trim() })),
    places: a.places.map((e: any) => ({ name: e.name.trim(), description: (e.description || '').trim() })),
    highlightQuote: a.highlightQuote ? { text: a.highlightQuote.text.trim(), timestamp: a.highlightQuote.timestamp ?? null } : null,
    swapSpeakers: !!a.swapSpeakers,
    headerPrompts: a.headerPrompts?.map((s: string) => s.trim()),
  };
}

export function swapSpeakerLabels(transcript: TranscriptItem[]): TranscriptItem[] {
  return transcript.map((t) => ({
    ...t,
    speaker: t.speaker === 'Dad' ? 'Izzy' : t.speaker === 'Izzy' ? 'Dad' : t.speaker,
  }));
}

const norm = (s: string) => (s || '').toLowerCase().trim();
function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

interface EntityPlan {
  embedded: EmbeddedEntity[];
  canonical: CanonicalEntity[];
  /** Names that matched an existing entity (by name or alias) -> the canonical name used. */
  matched: { given: string; canonical: string }[];
  /** Names that will become new entities. */
  created: string[];
}

/**
 * Match the analysis's entities against a registry — by canonical name first,
 * then by alias (absorbed duplicates from merge-characters) — and plan the new
 * ones. Pure: writes nothing. Existing descriptions are kept as they are.
 */
function planEntities(extracted: { name: string; description: string }[], registryPath: string): EntityPlan {
  const canonical: CanonicalEntity[] = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : [];
  const byName = new Map<string, CanonicalEntity>();
  for (const e of canonical) byName.set(norm(e.name), e);
  for (const e of canonical) for (const a of e.aliases ?? []) if (!byName.has(norm(a))) byName.set(norm(a), e);

  const embedded: EmbeddedEntity[] = [];
  const matched: EntityPlan['matched'] = [];
  const created: string[] = [];
  const seen = new Set<string>();
  for (const ex of extracted) {
    if (!ex?.name) continue;
    let entity = byName.get(norm(ex.name));
    if (entity) {
      matched.push({ given: ex.name, canonical: entity.name });
    } else {
      entity = { id: newId(), name: ex.name, description: ex.description || '', storyIds: [], firstAppearanceStoryId: null };
      canonical.push(entity);
      byName.set(norm(ex.name), entity);
      created.push(ex.name);
    }
    if (seen.has(entity.id)) continue; // two given names resolved to the same entity
    seen.add(entity.id);
    embedded.push({ id: entity.id, name: entity.name, description: entity.description });
  }
  return { embedded, canonical, matched, created };
}

export interface FinalizeOptions {
  /** Generate header-image candidates from analysis.headerPrompts (default true). */
  generateImage?: boolean;
  /** Rebuild the site bundle afterwards (default true). */
  build?: boolean;
  /** Validate and report only; write nothing. */
  dryRun?: boolean;
  onProgress?: ProgressFn;
}

export interface FinalizeResult {
  slug: string;
  record: StoryRecord;
  characters: { matched: EntityPlan['matched']; created: string[] };
  places: { matched: EntityPlan['matched']; created: string[] };
  quoteAnchored: boolean | null; // null = no quote
  hasHeaderPrompts: boolean;
  candidates: CandidateSet | null;
  /** Candidate generation failure (or missing prompts) is non-fatal; the message lands here. */
  candidatesError?: string;
  dryRun: boolean;
}

export async function finalizeStory(id: string, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  const progress: ProgressFn = opts.onProgress ?? (() => {});
  const draft = readDraft(id);
  const analysis = readAnalysis(id);
  const dryRun = !!opts.dryRun;

  const transcript = analysis.swapSpeakers ? swapSpeakerLabels(draft.transcript) : draft.transcript;
  if (analysis.swapSpeakers) progress('entities', 'Swapping Dad/Izzy labels as requested by the analysis.');

  const chars = planEntities(analysis.characters, CONTENT_CHARACTERS);
  const places = planEntities(analysis.places, CONTENT_PLACES);
  const describe = (label: string, plan: EntityPlan) => {
    const renamed = plan.matched.filter((m) => m.given !== m.canonical).map((m) => `"${m.given}" → ${m.canonical}`);
    progress(
      'entities',
      `${label}: ${plan.matched.length} existing${renamed.length ? ` (${renamed.join(', ')})` : ''}, ${plan.created.length} new${plan.created.length ? `: ${plan.created.join(', ')}` : ''}`,
    );
  };
  describe('Characters', chars);
  describe('Places', places);

  let highlightQuote: HighlightQuote | null = null;
  let quoteAnchored: boolean | null = null;
  if (analysis.highlightQuote?.text) {
    const recovered = recoverQuoteTimestamp(analysis.highlightQuote.text, transcript);
    quoteAnchored = recovered != null;
    const timestamp = recovered ?? (typeof analysis.highlightQuote.timestamp === 'number' ? analysis.highlightQuote.timestamp : null);
    highlightQuote = { text: analysis.highlightQuote.text, timestamp };
    progress('entities', quoteAnchored ? `Quote anchored at ${fmtTime(recovered!)}.` : 'WARNING: the highlight quote does not match a transcript line — copy it verbatim from transcript.txt.');
  }

  const manifest = readManifest();
  const existingSlugs = new Set(fs.existsSync(CONTENT_STORIES_DIR) ? fs.readdirSync(CONTENT_STORIES_DIR) : []);
  const slug = uniqueSlug(analysis.title, (s) => existingSlugs.has(s) || !!manifest[s]);

  const speakerMap = draft.transcription.speakerMap;
  const record: StoryRecord = {
    id: slug,
    title: analysis.title,
    date: draft.date,
    summary: analysis.summary,
    audioFilename: draft.sourceFilename,
    highlightQuote,
    transcript,
    characters: chars.embedded,
    places: places.embedded,
    ...computeWordCounts(transcript),
    transcription: {
      ...draft.transcription,
      speakerMap:
        analysis.swapSpeakers && speakerMap
          ? Object.fromEntries(Object.entries(speakerMap).map(([k, v]) => [k, v === 'Dad' ? 'Izzy' : v === 'Izzy' ? 'Dad' : v]))
          : speakerMap,
    },
  };

  const result: FinalizeResult = {
    slug,
    record,
    characters: { matched: chars.matched, created: chars.created },
    places: { matched: places.matched, created: places.created },
    quoteAnchored,
    hasHeaderPrompts: !!analysis.headerPrompts?.length,
    candidates: null,
    dryRun,
  };
  if (dryRun) {
    progress('done', `Dry run: would create content/stories/${slug}/ — nothing written.`);
    return result;
  }

  progress('write', `Saving "${analysis.title}" as ${slug}...`);
  const destDir = path.join(CONTENT_STORIES_DIR, slug);
  ensureDir(destDir);
  fs.copyFileSync(path.join(draftDir(id), 'source.m4a'), path.join(destDir, 'source.m4a'));
  fs.writeFileSync(path.join(destDir, 'story.json'), JSON.stringify(record, null, 2));

  // recompute canonical entity links across ALL stories (incl. the new one)
  const allStories: StoryRecord[] = fs
    .readdirSync(CONTENT_STORIES_DIR)
    .filter((s) => fs.existsSync(path.join(CONTENT_STORIES_DIR, s, 'story.json')))
    .map((s) => JSON.parse(fs.readFileSync(path.join(CONTENT_STORIES_DIR, s, 'story.json'), 'utf8')));
  const withAliases = (list: CanonicalEntity[], linked: CanonicalEntity[]) =>
    linked.map((c) => {
      const src = list.find((e) => e.id === c.id);
      return src?.aliases?.length ? { ...c, aliases: src.aliases } : c;
    });
  fs.writeFileSync(CONTENT_CHARACTERS, JSON.stringify(withAliases(chars.canonical, recomputeEntityLinks(chars.canonical, allStories, 'characters')), null, 2));
  fs.writeFileSync(CONTENT_PLACES, JSON.stringify(withAliases(places.canonical, recomputeEntityLinks(places.canonical, allStories, 'places')), null, 2));

  manifest[slug] = { audioHash: draft.audioHash, sourceFilename: draft.sourceFilename, date: draft.date };
  fs.writeFileSync(CONTENT_MANIFEST, JSON.stringify(manifest, null, 2));

  fs.rmSync(draftDir(id), { recursive: true, force: true });
  progress('write', `Added "${analysis.title}" as ${slug}. Draft removed.`);

  // header-image candidates (the story is already fully persisted, so a failure
  // here just leaves the story header-less until a candidate is selected)
  if (opts.generateImage !== false) {
    if (!analysis.headerPrompts?.length) {
      result.candidatesError = 'no headerPrompts in analysis.json';
      const refNames = loadCharacterRefImages(record.characters).map((r) => r.name);
      progress('candidates', `No header prompts in the analysis — skipped. To add a header later:\n${headerPromptBrief(record, refNames)}`);
    } else {
      try {
        progress('candidates', `Generating ${analysis.headerPrompts.length} header-image candidates with the Gemini image model...`);
        result.candidates = await generateHeaderCandidates(slug, record, { prompts: analysis.headerPrompts });
      } catch (e: any) {
        result.candidatesError = e?.message || String(e);
        progress('candidates', `Candidate generation failed (${result.candidatesError}); continuing without a header. Retry: npm run regen-image -- ${slug} --prompts <file>`);
      }
    }
  }

  if (opts.build !== false) {
    progress('build', 'Rebuilding site bundle...');
    await buildSite();
  }
  progress('done', `Done: ${slug}`);
  return result;
}
