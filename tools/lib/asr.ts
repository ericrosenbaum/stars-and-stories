/**
 * Transcription. ElevenLabs Scribe is THE engine for the archive: `npm run add`
 * and `npm run retranscribe` always use it. OpenAI's diarizing model is kept
 * only so `npm run bakeoff` can compare against it. Every engine returns the
 * same normalized TranscriptItem[] with speakers mapped to "Dad"/"Izzy".
 *
 * Name consistency, without any LLM in the loop:
 *  - Scribe receives the archive's canonical character/place names as
 *    `keyterms` (lib/lexicon.ts: every recurring name, capped at 250 because
 *    larger lists break Scribe's diarization), so familiar names come back in
 *    the spelling the archive already uses.
 *  - Every transcript then passes through the curated misspelling list in
 *    content/spellings.json (lib/spellings.ts).
 *  - Raw diarization labels (speaker_0/1) are mapped to Dad/Izzy by aligning
 *    against the story's previous transcript when there is one (retranscribe),
 *    otherwise from dialogue cues — see mapSpeakers().
 */
import fs from 'node:fs';
import path from 'node:path';
import { countWords, computeWordCounts } from './wordcount.ts';
import { loadKeyterms } from './lexicon.ts';
import { normalizeTranscriptSpellings } from './spellings.ts';
import type { TranscriptItem } from './types.ts';

export type EngineId = 'scribe-v2' | 'openai-diarize';
export const ALL_ENGINES: EngineId[] = ['scribe-v2', 'openai-diarize'];
/** The one engine the archive is transcribed with. */
export const ARCHIVE_ENGINE: EngineId = 'scribe-v2';

// FAKE_GEMINI=1 (the pipeline-wide "no paid API calls" switch) also stubs the
// transcription call with a canned two-speaker transcript.
const FAKE = !!process.env.FAKE_GEMINI && process.env.FAKE_GEMINI !== '0';

export type SpeakerMapMethod = 'reference' | 'cues' | 'word-share' | 'fake';

export interface EngineResult {
  engine: EngineId;
  model: string; // resolved model id
  transcript: TranscriptItem[]; // speakers mapped to Dad/Izzy, spellings normalized
  counts: ReturnType<typeof computeWordCounts>; // total/Izzy/Dad word counts
  rawSpeakerMap?: Record<string, string>; // e.g. { speaker_0: 'Dad' }
  speakerMapMethod?: SpeakerMapMethod;
  /** 'low' means the mapping deserves a human glance (signals disagreed or were weak). */
  speakerMapConfidence?: 'high' | 'low';
  /** How the mapping was decided (shares, cue counts) — printed when confidence is low. */
  speakerMapNote?: string;
  keytermCount: number;
  /** Spelling rules that fired on this transcript ("from -> to": count). */
  spellingFixes: Record<string, number>;
  elapsedMs: number;
  estimatedCostUsd: number | null;
  costNote: string; // the formula used, so estimates are auditable
}

/** The provider refused the request for want of credits/quota — stop the batch, don't retry. */
export class QuotaExceededError extends Error {
  constructor(
    public engine: EngineId,
    public status: number,
    detail: string,
  ) {
    super(`${engine}: quota/credits exhausted (HTTP ${status}): ${detail}`);
    this.name = 'QuotaExceededError';
  }
}

/** MIME type for an audio file, by extension (bakeoff accepts any audio path). */
export function mimeTypeFor(audioPath: string): string {
  const map: Record<string, string> = {
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.webm': 'audio/webm',
  };
  return map[path.extname(audioPath).toLowerCase()] || 'audio/mp4';
}

/** Audio duration in seconds via music-metadata, or null when unreadable. */
export async function audioDurationSec(audioPath: string): Promise<number | null> {
  try {
    const mm = await import('music-metadata');
    return (await mm.parseFile(audioPath)).format.duration ?? null;
  } catch {
    return null;
  }
}

export function engineModel(engine: EngineId): string {
  switch (engine) {
    case 'scribe-v2':
      return process.env.ELEVENLABS_STT_MODEL || 'scribe_v2';
    case 'openai-diarize':
      return process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe-diarize';
  }
}

export function engineAvailable(engine: EngineId): { ok: boolean; reason?: string } {
  if (FAKE) return { ok: true };
  if (engine === 'scribe-v2') {
    return process.env.ELEVENLABS_API_KEY ? { ok: true } : { ok: false, reason: 'ELEVENLABS_API_KEY not set' };
  }
  return process.env.OPENAI_API_KEY ? { ok: true } : { ok: false, reason: 'OPENAI_API_KEY not set' };
}

// Pricing as of 2026-09 — spot-check against the providers' pricing pages
// before trusting an estimate to the cent. Scribe adds 20% when keyterms are
// sent (we always send them).
const PRICING = {
  'scribe-v2': { perHour: 0.22, keytermSurcharge: 1.2 },
  'openai-diarize': { perMinute: 0.006 },
} as const;

export function estimateCost(
  engine: EngineId,
  durationSec: number | null,
  keyterms = 0,
): { usd: number | null; note: string } {
  if (durationSec == null || !isFinite(durationSec) || durationSec <= 0) {
    return { usd: null, note: 'audio duration unknown — no estimate' };
  }
  const min = durationSec / 60;
  if (engine === 'scribe-v2') {
    const p = PRICING[engine];
    const mult = keyterms ? p.keytermSurcharge : 1;
    const usd = (durationSec / 3600) * p.perHour * mult;
    return { usd, note: `${min.toFixed(1)} min × $${p.perHour}/hr${keyterms ? ' × 1.2 (keyterms)' : ''}` };
  }
  const usd = min * PRICING[engine].perMinute;
  return { usd, note: `${min.toFixed(1)} min × $${PRICING[engine].perMinute}/min` };
}

// ---- engines ----

interface RawSegment {
  rawSpeaker: string;
  text: string;
  start: number;
}

function dumpRaw(dir: string | undefined, engine: EngineId, data: unknown): string | null {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${engine}-raw.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  } catch {
    return null;
  }
}

/** Throw QuotaExceededError for the provider's out-of-credits responses, a plain Error otherwise. */
async function throwApiError(engine: EngineId, res: Response): Promise<never> {
  const body = (await res.text()).slice(0, 500);
  const quotaish = /quota|credit|exceed|insufficient|payment|billing|limit_reached/i.test(body);
  if (res.status === 402 || res.status === 429 || (res.status === 401 && quotaish) || (res.status === 400 && quotaish)) {
    throw new QuotaExceededError(engine, res.status, body);
  }
  throw new Error(`${engine === 'scribe-v2' ? 'ElevenLabs' : 'OpenAI'} API error ${res.status}: ${body}`);
}

/**
 * Fold ElevenLabs word-level output into per-turn segments. Also splits very
 * long same-speaker runs at sentence boundaries so lines stay readable and
 * "play from here" stays granular.
 */
function foldScribeWords(words: any[]): RawSegment[] {
  const MAX_SEGMENT_CHARS = 250;
  const segments: RawSegment[] = [];
  for (const w of words) {
    if (w?.type === 'audio_event') continue;
    const last = segments[segments.length - 1];
    if (w?.type === 'spacing') {
      if (last) last.text += w.text ?? ' ';
      continue;
    }
    const speaker = String(w?.speaker_id ?? 'speaker_0');
    const splitLong = last && last.text.length > MAX_SEGMENT_CHARS && /[.?!…]["']?\s*$/.test(last.text);
    if (last && last.rawSpeaker === speaker && !splitLong) {
      last.text += w?.text ?? '';
    } else {
      segments.push({
        rawSpeaker: speaker,
        text: w?.text ?? '',
        start: typeof w?.start === 'number' ? w.start : (last?.start ?? 0),
      });
    }
  }
  return segments.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

async function runScribe(
  audioPath: string,
  model: string,
  keyterms: string[],
  rawDumpDir?: string,
): Promise<RawSegment[]> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)], { type: mimeTypeFor(audioPath) }), path.basename(audioPath));
  form.append('model_id', model);
  form.append('language_code', 'en');
  form.append('diarize', 'true');
  // NOT num_speakers=2: measured 2026-09-13, capping the speaker count made
  // Scribe merge Dad and Izzy into one label on some recordings and keep a
  // noise cluster as the "second speaker". Uncapped, the two real voices
  // separate and any small extra cluster is folded in by mapSpeakers().
  form.append('tag_audio_events', 'false');
  for (const term of keyterms) form.append('keyterms', term);
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    body: form,
  });
  if (!res.ok) await throwApiError('scribe-v2', res);
  const data: any = await res.json();
  if (!Array.isArray(data?.words) || !data.words.length) {
    const dumped = dumpRaw(rawDumpDir, 'scribe-v2', data);
    throw new Error(
      `Unexpected ElevenLabs response shape (no words[])${dumped ? ` — raw response saved to ${dumped}` : ''}`,
    );
  }
  return foldScribeWords(data.words);
}

async function runOpenAI(audioPath: string, model: string, rawDumpDir?: string): Promise<RawSegment[]> {
  const size = fs.statSync(audioPath).size;
  if (size > 25 * 1024 * 1024) {
    throw new Error(
      `Audio is ${(size / 1024 / 1024).toFixed(1)} MB, over OpenAI's 25 MB upload limit. ` +
        `Re-encode it smaller first: ffmpeg -i in.m4a -ac 1 -b:a 48k out.m4a`,
    );
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)], { type: mimeTypeFor(audioPath) }), path.basename(audioPath));
  form.append('model', model);
  form.append('response_format', 'diarized_json');
  // The diarization models reject the request without an explicit chunking
  // strategy; "auto" lets the server pick VAD boundaries.
  form.append('chunking_strategy', 'auto');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) await throwApiError('openai-diarize', res);
  const data: any = await res.json();
  const segments = data?.segments;
  if (!Array.isArray(segments) || !segments.length) {
    const dumped = dumpRaw(rawDumpDir, 'openai-diarize', data);
    throw new Error(
      `Unexpected OpenAI response shape (no segments[])${dumped ? ` — raw response saved to ${dumped}` : ''}`,
    );
  }
  return segments
    .map((s: any) => ({
      rawSpeaker: String(s?.speaker ?? 'speaker_0'),
      text: String(s?.text ?? '').trim(),
      start: typeof s?.start === 'number' ? s.start : 0,
    }))
    .filter((s: RawSegment) => s.text);
}

function fakeSegments(): RawSegment[] {
  return [
    { rawSpeaker: 'speaker_0', text: 'Once upon a time there was a fake story. Izzy, who should be in it?', start: 0.5 },
    { rawSpeaker: 'speaker_1', text: 'Seeker! And Hattie the Mouse, Daddy.', start: 4.2 },
    { rawSpeaker: 'speaker_0', text: 'Seeker appeared, exactly as always, and knocked on the door of the hollow tree.', start: 8.9 },
    { rawSpeaker: 'speaker_1', text: 'Then the Testing Turtle showed up for the first time.', start: 13.1 },
    { rawSpeaker: 'speaker_0', text: 'The end.', start: 17.7 },
  ];
}

// ---- speaker mapping (raw diarization labels -> Dad/Izzy) ----

export interface SpeakerMapping {
  map: Record<string, string>;
  method: SpeakerMapMethod;
  confidence: 'high' | 'low';
  note: string;
}

const DAD_LABEL = 'Dad';
const IZZY_LABEL = 'Izzy';

/**
 * Dad = the most Dad-like raw label, Izzy = the next. Any further label is a
 * small extra cluster Scribe split off (noise, a cough, a third voice for a
 * moment) — fold it into whichever of the two it resembles more, so no words
 * fall outside the Izzy/Dad counts.
 */
function assignByRank(ranked: string[], dadLike: (raw: string) => boolean): Record<string, string> {
  const map: Record<string, string> = {};
  ranked.forEach((raw, i) => {
    map[raw] = i === 0 ? DAD_LABEL : i === 1 ? IZZY_LABEL : dadLike(raw) ? DAD_LABEL : IZZY_LABEL;
  });
  return map;
}

const normTokens = (text: string) =>
  (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

/**
 * Retranscription: vote each raw label against the story's PREVIOUS transcript.
 * Each new segment is matched to the old line with the most shared words within
 * a ±45 s window (old timestamps can be coarse — some legacy transcripts have
 * whole-second guesses — but the words are mostly the same), and that old
 * line's Dad/Izzy label gets the segment's word count as a vote. Falls back to
 * "the old line in effect at that time" when nothing matches textually.
 * Returns null when the reference is unusable.
 */
function mapByReference(
  segments: RawSegment[],
  reference: TranscriptItem[],
): SpeakerMapping | null {
  const ref = reference
    .filter((t) => typeof t.timestamp === 'number' && (t.speaker === DAD_LABEL || t.speaker === IZZY_LABEL))
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((t) => ({ ...t, tokens: new Set(normTokens(t.text)) }));
  if (ref.length < 4) return null;
  const WINDOW = 45;
  const votes = new Map<string, { Dad: number; Izzy: number }>();
  let votedWords = 0;
  let totalWords = 0;
  let textMatches = 0;
  for (const s of segments) {
    const words = countWords(s.text);
    totalWords += words;
    const toks = normTokens(s.text);
    let best: { score: number; speaker: string } | null = null;
    for (const r of ref) {
      if (Math.abs(r.timestamp - s.start) > WINDOW) continue;
      let shared = 0;
      for (const w of toks) if (r.tokens.has(w)) shared++;
      const score = toks.length ? shared / toks.length : 0;
      if (!best || score > best.score) best = { score, speaker: r.speaker };
    }
    let speaker: string | null = null;
    if (best && best.score >= 0.34 && toks.length >= 2) {
      speaker = best.speaker;
      textMatches++;
    } else {
      // time fallback: the last old line starting at or before this segment
      let active: TranscriptItem | null = null;
      for (const r of ref) {
        if (r.timestamp <= s.start) active = r;
        else break;
      }
      if (active) speaker = active.speaker;
    }
    if (!speaker) continue;
    const v = votes.get(s.rawSpeaker) ?? { Dad: 0, Izzy: 0 };
    v[speaker as 'Dad' | 'Izzy'] += words;
    votes.set(s.rawSpeaker, v);
    votedWords += words;
  }
  const raws = [...new Set(segments.map((s) => s.rawSpeaker))];
  if (!raws.every((r) => votes.has(r))) return null;
  // Rank by "how Dad-like": share of words landing on old Dad lines.
  const dadShare = (raw: string) => {
    const v = votes.get(raw)!;
    return (v.Dad + 0.5) / (v.Dad + v.Izzy + 1);
  };
  const ranked = [...raws].sort((a, b) => dadShare(b) - dadShare(a));
  const map = assignByRank(ranked, (r) => dadShare(r) >= 0.5);
  const shares = ranked.map((r) => dadShare(r));
  const coverage = totalWords ? votedWords / totalWords : 0;
  // Confident when the two labels are clearly separated (Izzy's short
  // interjections often land on a neighbouring old Dad line, so the "Izzy"
  // label rarely scores near 0%), and most of the recording took part.
  const confident = raws.length < 2 || (shares[0] >= 0.6 && shares[0] - shares[1] >= 0.25 && coverage >= 0.5);
  return {
    map,
    method: 'reference',
    confidence: confident ? 'high' : 'low',
    note:
      ranked.map((r, i) => `${r}: ${(shares[i] * 100).toFixed(0)}% on old Dad lines`).join(', ') +
      `; ${textMatches}/${segments.length} segments matched by text, ${(coverage * 100).toFixed(0)}% of words voted`,
  };
}

/**
 * New recordings: dialogue cues. The speaker who says "Daddy/Dada" is Izzy;
 * the one who says "Izzy" (or narrates to "sweetie", "kiddo") is Dad. Line
 * length and word share break ties (Dad's turns run longer and he usually
 * talks more — but not always, which is why they only break ties).
 */
function mapByCues(segments: RawSegment[]): SpeakerMapping {
  const stats = new Map<string, { words: number; lines: number; dadCues: number; izzyCues: number }>();
  const DAD_CUES = /\b(izzy|isabella|sweetie|sweetheart|kiddo|good job|great idea|do you want)\b/i;
  // "Daddy Mouse", "Papa Mole", "Captain Daddy" are story characters (narrated by Dad) — skip those.
  const IZZY_CUES = /\b(?<!captain |nurse )(daddy|dada|dadda)\b(?!\s+(mouse|mole|robot|space|rock))/i;
  for (const s of segments) {
    const e = stats.get(s.rawSpeaker) ?? { words: 0, lines: 0, dadCues: 0, izzyCues: 0 };
    e.words += countWords(s.text);
    e.lines++;
    if (DAD_CUES.test(s.text)) e.dadCues++;
    if (IZZY_CUES.test(s.text)) e.izzyCues++;
    stats.set(s.rawSpeaker, e);
  }
  const raws = [...stats.keys()];
  const cueScore = (r: string) => stats.get(r)!.dadCues - stats.get(r)!.izzyCues;
  const meanLen = (r: string) => stats.get(r)!.words / Math.max(stats.get(r)!.lines, 1);
  const anyCues = raws.some((r) => stats.get(r)!.dadCues || stats.get(r)!.izzyCues);
  const ranked = [...raws].sort(
    (a, b) => cueScore(b) - cueScore(a) || meanLen(b) - meanLen(a) || stats.get(b)!.words - stats.get(a)!.words,
  );
  // extras: long-lined clusters read as Dad, short-lined ones as Izzy
  const map = assignByRank(ranked, (r) => cueScore(r) > 0 || (cueScore(r) === 0 && meanLen(r) >= meanLen(ranked[1])));
  let confidence: 'high' | 'low' = 'low';
  if (raws.length < 2) confidence = 'high';
  else if (anyCues) {
    const gap = cueScore(ranked[0]) - cueScore(ranked[1]);
    const agreesWithLength = meanLen(ranked[0]) >= meanLen(ranked[1]);
    confidence = gap >= 3 && agreesWithLength ? 'high' : 'low';
  }
  const note = ranked
    .map((r) => {
      const e = stats.get(r)!;
      return `${r}: ${e.words}w, ${meanLen(r).toFixed(1)}w/line, cues Dad ${e.dadCues}/Izzy ${e.izzyCues}`;
    })
    .join('; ');
  return { map, method: anyCues ? 'cues' : 'word-share', confidence, note };
}

export function mapSpeakers(segments: RawSegment[], reference?: TranscriptItem[]): SpeakerMapping {
  if (reference?.length) {
    const byRef = mapByReference(segments, reference);
    if (byRef) {
      // Sanity check against the cues; disagreement is worth a human glance.
      const byCues = mapByCues(segments);
      const agree = Object.keys(byRef.map).every((r) => byRef.map[r] === byCues.map[r]);
      if (!agree && byCues.confidence === 'high') {
        return { ...byRef, confidence: 'low', note: `${byRef.note} | cues disagree: ${byCues.note}` };
      }
      return byRef;
    }
  }
  return mapByCues(segments);
}

// ---- diarization sanity ----

/** Share of words held by the smaller of the two main speakers (0 = one voice). */
export function minoritySpeakerShare(transcript: { speaker: string; text: string }[]): number {
  const words = new Map<string, number>();
  for (const t of transcript) words.set(t.speaker, (words.get(t.speaker) ?? 0) + countWords(t.text));
  const sorted = [...words.values()].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  return total && sorted.length > 1 ? sorted[1] / total : 0;
}

/**
 * Did Scribe fold both voices into one label? Judged against the previous
 * transcript when there is one (it knew the recording had two real voices),
 * otherwise by an absolute floor on recordings long enough to matter.
 */
export function diarizationCollapsed(
  transcript: { speaker: string; text: string }[],
  reference?: { speaker: string; text: string }[],
  durationSec?: number | null,
): boolean {
  const share = minoritySpeakerShare(transcript);
  if (reference?.length) return share < 0.06 && minoritySpeakerShare(reference) >= 0.12;
  return share < 0.04 && (durationSec ?? 0) > 180;
}

// ---- entry point ----

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RunEngineOptions {
  /** Keyterms for Scribe. Default: loadKeyterms() (recurring canonical names, capped). Pass [] to send none. */
  keyterms?: string[];
  /** The story's previous transcript, for reference-based speaker mapping (retranscribe). */
  referenceTranscript?: TranscriptItem[];
  durationSec?: number | null;
  rawDumpDir?: string;
}

/** Run one engine on one audio file. Throws with a clear message on failure. */
export async function runEngine(
  engine: EngineId,
  audioPath: string,
  opts: RunEngineOptions = {},
): Promise<EngineResult> {
  const avail = engineAvailable(engine);
  if (!avail.ok) throw new Error(`${engine} unavailable: ${avail.reason}`);
  const model = engineModel(engine);
  const keyterms = opts.keyterms ?? loadKeyterms().terms;
  const start = Date.now();

  let segments: RawSegment[];
  let mapping: SpeakerMapping;
  if (FAKE) {
    await new Promise((r) => setTimeout(r, 800));
    segments = fakeSegments();
    mapping = { map: { speaker_0: DAD_LABEL, speaker_1: IZZY_LABEL }, method: 'fake', confidence: 'high', note: 'FAKE mode' };
  } else {
    segments =
      engine === 'scribe-v2'
        ? await runScribe(audioPath, model, keyterms, opts.rawDumpDir)
        : await runOpenAI(audioPath, model, opts.rawDumpDir);
    mapping = mapSpeakers(segments, opts.referenceTranscript);
  }

  const raw: TranscriptItem[] = segments.map((s) => ({
    speaker: mapping.map[s.rawSpeaker] || s.rawSpeaker,
    text: s.text,
    timestamp: round2(s.start),
  }));
  const { transcript, fixes } = normalizeTranscriptSpellings(raw);

  const elapsedMs = Date.now() - start;
  const counts = computeWordCounts(transcript);
  const cost = estimateCost(engine, opts.durationSec ?? null, engine === 'scribe-v2' ? keyterms.length : 0);
  return {
    engine,
    model,
    transcript,
    counts,
    rawSpeakerMap: mapping.map,
    speakerMapMethod: mapping.method,
    speakerMapConfidence: mapping.confidence,
    speakerMapNote: mapping.note,
    keytermCount: engine === 'scribe-v2' ? keyterms.length : 0,
    spellingFixes: fixes,
    elapsedMs,
    estimatedCostUsd: cost.usd,
    costNote: cost.note,
  };
}

/** One-line description of a mapping for CLI logs. */
export function describeMapping(r: EngineResult): string {
  const mapStr = Object.entries(r.rawSpeakerMap ?? {})
    .map(([k, v]) => `${k} → ${v}`)
    .join(', ');
  return `${mapStr} (${r.speakerMapMethod}, ${r.speakerMapConfidence} confidence${r.speakerMapConfidence === 'low' && r.speakerMapNote ? `: ${r.speakerMapNote}` : ''})`;
}
