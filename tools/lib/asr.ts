/**
 * Transcription engine registry for the bake-off and retranscribe tools.
 * Every engine returns the same normalized TranscriptItem[] with speakers
 * already mapped to "Dad"/"Izzy" so downstream word counts and the site
 * work regardless of which engine produced the transcript.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@google/genai';
import { getAI, transcribeAudio, transcribeModel } from './gemini.ts';
import { countWords, computeWordCounts } from './wordcount.ts';
import type { NameLexicon } from './lexicon.ts';
import type { TranscriptItem } from './types.ts';

export type EngineId = 'gemini-flash' | 'gemini-pro' | 'scribe-v2' | 'assemblyai' | 'openai-diarize';
export const ALL_ENGINES: EngineId[] = [
  'gemini-flash',
  'gemini-pro',
  'scribe-v2',
  'assemblyai',
  'openai-diarize',
];

/**
 * Engine used by the primary pipeline (`npm run add`) and the default for
 * `npm run retranscribe`. Override per-run with `--engine`, or globally with
 * `TRANSCRIBE_ENGINE` in tools/.env (falls back to the default if unrecognized).
 */
export function defaultEngine(): EngineId {
  const env = process.env.TRANSCRIBE_ENGINE;
  return env && (ALL_ENGINES as string[]).includes(env) ? (env as EngineId) : 'scribe-v2';
}

export interface EngineResult {
  engine: EngineId;
  model: string; // resolved model id
  transcript: TranscriptItem[]; // speakers already mapped to Dad/Izzy
  counts: ReturnType<typeof computeWordCounts>; // total/Izzy/Dad word counts
  rawSpeakerMap?: Record<string, string>; // e.g. { speaker_0: 'Dad' } (acoustic engines only)
  speakerMapMethod?: 'gemini' | 'word-share'; // how the raw labels were mapped
  keytermCount: number; // names sent to bias the engine (0 when it takes none)
  elapsedMs: number;
  estimatedCostUsd: number | null;
  costNote: string; // the formula used, so estimates are auditable
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
    case 'gemini-flash':
      return transcribeModel();
    case 'gemini-pro':
      return process.env.GEMINI_PRO_MODEL || 'gemini-3.1-pro-preview';
    case 'scribe-v2':
      return process.env.ELEVENLABS_STT_MODEL || 'scribe_v2';
    case 'assemblyai':
      return process.env.ASSEMBLYAI_STT_MODEL || 'universal-3-5-pro';
    case 'openai-diarize':
      return process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe-diarize';
  }
}

export function engineAvailable(engine: EngineId): { ok: boolean; reason?: string } {
  if (engine === 'scribe-v2') {
    return process.env.ELEVENLABS_API_KEY ? { ok: true } : { ok: false, reason: 'ELEVENLABS_API_KEY not set' };
  }
  if (engine === 'assemblyai') {
    return process.env.ASSEMBLYAI_API_KEY ? { ok: true } : { ok: false, reason: 'ASSEMBLYAI_API_KEY not set' };
  }
  if (engine === 'openai-diarize') {
    return process.env.OPENAI_API_KEY ? { ok: true } : { ok: false, reason: 'OPENAI_API_KEY not set' };
  }
  return process.env.GEMINI_API_KEY || process.env.API_KEY
    ? { ok: true }
    : { ok: false, reason: 'GEMINI_API_KEY not set' };
}

// ---- keyterm prompting ----

// Both acoustic APIs cap how many terms they will bias toward, and the
// archive's registries are far bigger than either cap (hundreds of characters
// and places, most of them one-off). lexicon.ts already sorts by how many
// stories an entity appears in, so taking from the front keeps the recurring
// cast — the names worth spelling consistently.
const KEYTERM_LIMITS = {
  // ElevenLabs: 100 terms, 50 chars and 5 words each, scribe_v2 only.
  'scribe-v2': 100,
  // AssemblyAI's keyterms_prompt allows far more than the lexicon produces,
  // so the lexicon's own caps (120 characters + 60 places) are the real limit.
  assemblyai: 200,
} as const;
const KEYTERM_MAX_CHARS = 50;
const KEYTERM_MAX_WORDS = 5;

/** Flatten the name lexicon into a deduped keyterm list within `max` terms. */
export function keytermsFor(lexicon: NameLexicon | undefined, max: number): string[] {
  if (!lexicon) return [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const take = (names: string[], upTo: number) => {
    for (const name of names) {
      if (terms.length >= upTo) return;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      if (name.length > KEYTERM_MAX_CHARS) continue;
      if (name.trim().split(/\s+/).length > KEYTERM_MAX_WORDS) continue;
      seen.add(key);
      terms.push(name);
    }
  };
  // Characters get first claim on two thirds of the budget: a mis-heard
  // character name costs more than a mis-heard place, since characters.json
  // drives the codex cross-links. Places fill from there, and whatever they
  // leave unused goes back to the characters.
  take(lexicon.characters, Math.ceil((max * 2) / 3));
  take(lexicon.places, max);
  take(lexicon.characters, max);
  return terms;
}

// Pricing as of 2026-09 — spot-check against the providers' pricing pages
// before trusting an estimate to the cent. Gemini audio is billed at 32
// tokens/second of input; the per-token audio rates below are the least
// certain numbers here (Google's audio rate differs from the text rate).
const GEMINI_AUDIO_TOKENS_PER_SEC = 32;
const PRICING = {
  'gemini-flash': { audioInPerM: 1.0, outPerM: 3.0 },
  'gemini-pro': { audioInPerM: 2.0, outPerM: 12.0 },
  // ElevenLabs' pricing page lists keyterm prompting as a $0.05/hr add-on,
  // while their own STT docs call it free. Assume the surcharge — an estimate
  // that comes in under budget is the harmless direction to be wrong in.
  'scribe-v2': { perHour: 0.22, keytermsPerHour: 0.05 },
  // Diarization and keyterms_prompt are both included in the base rate.
  assemblyai: { perHour: 0.21, keytermsPerHour: 0 },
  'openai-diarize': { perMinute: 0.006 },
} as const;

export function estimateCost(
  engine: EngineId,
  durationSec: number | null,
  transcriptWords = 0,
  keytermCount = 0,
): { usd: number | null; note: string } {
  if (durationSec == null || !isFinite(durationSec) || durationSec <= 0) {
    return { usd: null, note: 'audio duration unknown — no estimate' };
  }
  const min = durationSec / 60;
  if (engine === 'scribe-v2' || engine === 'assemblyai') {
    const { perHour, keytermsPerHour } = PRICING[engine];
    const rate = perHour + (keytermCount > 0 ? keytermsPerHour : 0);
    const usd = (durationSec / 3600) * rate;
    const addOn =
      keytermCount > 0 && keytermsPerHour > 0
        ? ` (incl. $${keytermsPerHour}/hr for ${keytermCount} keyterms)`
        : keytermCount > 0
          ? ` (${keytermCount} keyterms, no surcharge)`
          : '';
    return { usd, note: `${min.toFixed(1)} min × $${rate.toFixed(2)}/hr${addOn}` };
  }
  if (engine === 'openai-diarize') {
    const usd = min * PRICING[engine].perMinute;
    return { usd, note: `${min.toFixed(1)} min × $${PRICING[engine].perMinute}/min` };
  }
  const p = PRICING[engine];
  const inTokens = durationSec * GEMINI_AUDIO_TOKENS_PER_SEC;
  const outTokens = Math.round(transcriptWords * 1.4) || Math.round(durationSec * 3);
  const usd = (inTokens / 1e6) * p.audioInPerM + (outTokens / 1e6) * p.outPerM;
  return {
    usd,
    note: `${inTokens.toLocaleString()} audio tokens × $${p.audioInPerM}/M + ~${outTokens.toLocaleString()} output tokens × $${p.outPerM}/M (estimated)`,
  };
}

// ---- acoustic engines ----

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
  form.append('diarize', 'true');
  // Repeated fields, one term each — a single JSON-array field trips the
  // API's 50-character-per-keyword check against the whole serialized string.
  for (const term of keyterms) form.append('keyterms', term);
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data: any = await res.json();
  if (!Array.isArray(data?.words) || !data.words.length) {
    const dumped = dumpRaw(rawDumpDir, 'scribe-v2', data);
    throw new Error(
      `Unexpected ElevenLabs response shape (no words[])${dumped ? ` — raw response saved to ${dumped}` : ''}`,
    );
  }
  return foldScribeWords(data.words);
}

/**
 * AssemblyAI is asynchronous: upload the file, submit a transcript job, then
 * poll until it reaches a terminal state. Utterance timestamps are in
 * milliseconds and speakers come back as "A"/"B", which mapSpeakers resolves
 * to Dad/Izzy the same way it does ElevenLabs' speaker_N labels.
 */
async function runAssemblyAI(
  audioPath: string,
  model: string,
  keyterms: string[],
  rawDumpDir?: string,
): Promise<RawSegment[]> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY!;
  const upload = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(audioPath),
  });
  if (!upload.ok) {
    throw new Error(`AssemblyAI upload error ${upload.status}: ${(await upload.text()).slice(0, 300)}`);
  }
  const uploadUrl = (await upload.json() as any)?.upload_url;
  if (!uploadUrl) throw new Error('AssemblyAI upload returned no upload_url');

  const submit = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speech_model: model,
      speaker_labels: true,
      // Two people, always — telling the diarizer so stops it inventing a
      // third speaker out of a funny voice Dad puts on for a character.
      speakers_expected: 2,
      ...(keyterms.length ? { keyterms_prompt: keyterms } : {}),
    }),
  });
  if (!submit.ok) {
    throw new Error(`AssemblyAI submit error ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  }
  const jobId = (await submit.json() as any)?.id;
  if (!jobId) throw new Error('AssemblyAI submit returned no transcript id');

  // A 20-minute memo takes a few minutes; give up well after that rather than
  // polling forever if a job wedges.
  const deadline = Date.now() + 30 * 60 * 1000;
  let data: any;
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${jobId}`, {
      headers: { Authorization: apiKey },
    });
    if (!poll.ok) {
      throw new Error(`AssemblyAI poll error ${poll.status}: ${(await poll.text()).slice(0, 300)}`);
    }
    data = await poll.json();
    if (data?.status === 'completed') break;
    if (data?.status === 'error') throw new Error(`AssemblyAI transcription failed: ${data?.error}`);
    if (Date.now() > deadline) {
      throw new Error(`AssemblyAI job ${jobId} still "${data?.status}" after 30 min — check the dashboard`);
    }
  }

  const utterances = data?.utterances;
  if (!Array.isArray(utterances) || !utterances.length) {
    const dumped = dumpRaw(rawDumpDir, 'assemblyai', data);
    throw new Error(
      `Unexpected AssemblyAI response shape (no utterances[])${dumped ? ` — raw response saved to ${dumped}` : ''}`,
    );
  }
  return utterances
    .map((u: any) => ({
      rawSpeaker: `speaker_${u?.speaker ?? 'A'}`,
      text: String(u?.text ?? '').trim(),
      start: typeof u?.start === 'number' ? u.start / 1000 : 0,
    }))
    .filter((s: RawSegment) => s.text);
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
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
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

// ---- speaker mapping (raw diarization labels -> Dad/Izzy) ----

/**
 * Content-based mapping via a tiny Gemini text call. A "Dad talks more"
 * word-share heuristic is wrong on exactly the Izzy-led sessions the bake-off
 * targets, so word share is only the fallback.
 */
async function mapSpeakersWithGemini(
  samples: Map<string, { lines: string[]; words: number }>,
): Promise<Record<string, string> | null> {
  const raws = [...samples.keys()];
  const sampleBlock = raws
    .map((raw) => {
      const s = samples.get(raw)!;
      return `${raw} (${s.words} words total):\n${s.lines.map((l) => `- ${l}`).join('\n')}`;
    })
    .join('\n\n');
  try {
    const response = await getAI().models.generateContent({
      model: process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash',
      contents: [
        {
          parts: [
            {
              text: `This transcript came from automatic speaker diarization of a storytelling session between exactly two people:
              - "Dad" — an adult father. Tends to narrate in full sentences and often addresses his daughter by name or asks her questions.
              - "Izzy" — his young daughter (a small child). Shorter lines, child vocabulary and grammar, may call him "Daddy" or "Dada".

              Decide which real person each raw diarization label belongs to, based on the sample lines below.

              ${sampleBlock}

              Return JSON mapping EVERY raw label to either "Dad" or "Izzy".`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mappings: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  raw: { type: Type.STRING },
                  speaker: { type: Type.STRING, enum: ['Dad', 'Izzy'] },
                },
                required: ['raw', 'speaker'],
              },
            },
          },
          required: ['mappings'],
        },
      },
    });
    const text = response.text;
    if (!text) return null;
    const map: Record<string, string> = {};
    for (const m of JSON.parse(text)?.mappings ?? []) {
      if (raws.includes(m.raw) && (m.speaker === 'Dad' || m.speaker === 'Izzy')) map[m.raw] = m.speaker;
    }
    if (raws.some((r) => !map[r])) return null; // must map every label
    // Two-speaker recordings must have one Dad and one Izzy.
    if (raws.length === 2 && new Set(Object.values(map)).size !== 2) return null;
    return map;
  } catch {
    return null;
  }
}

async function mapSpeakers(
  segments: RawSegment[],
): Promise<{ map: Record<string, string>; method: 'gemini' | 'word-share' }> {
  const samples = new Map<string, { lines: string[]; words: number }>();
  for (const s of segments) {
    let e = samples.get(s.rawSpeaker);
    if (!e) samples.set(s.rawSpeaker, (e = { lines: [], words: 0 }));
    e.words += countWords(s.text);
    if (e.lines.length < 15) e.lines.push(s.text.slice(0, 200));
  }

  const llmMap = await mapSpeakersWithGemini(samples);
  if (llmMap) return { map: llmMap, method: 'gemini' };

  // Fallback: the speaker with the most words is Dad, the runner-up Izzy,
  // any extra diarization labels keep a generic name.
  const byWords = [...samples.entries()].sort((a, b) => b[1].words - a[1].words);
  const map: Record<string, string> = {};
  byWords.forEach(([raw], i) => {
    map[raw] = i === 0 ? 'Dad' : i === 1 ? 'Izzy' : `Speaker ${i + 1}`;
  });
  return { map, method: 'word-share' };
}

// ---- entry point ----

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Run one engine on one audio file. Throws with a clear message on failure. */
export async function runEngine(
  engine: EngineId,
  audioPath: string,
  opts: { lexicon?: NameLexicon; durationSec?: number | null; rawDumpDir?: string } = {},
): Promise<EngineResult> {
  const avail = engineAvailable(engine);
  if (!avail.ok) throw new Error(`${engine} unavailable: ${avail.reason}`);
  const model = engineModel(engine);
  const start = Date.now();

  let transcript: TranscriptItem[];
  let rawSpeakerMap: Record<string, string> | undefined;
  let speakerMapMethod: 'gemini' | 'word-share' | undefined;
  // The Gemini engines get the lexicon in their prompt; the acoustic ones take
  // it as keyterms, except OpenAI's endpoint, which has nowhere to put it.
  let keyterms: string[] = [];

  if (engine === 'gemini-flash' || engine === 'gemini-pro') {
    transcript = await transcribeAudio(audioPath, mimeTypeFor(audioPath), { model, lexicon: opts.lexicon });
  } else {
    let segments: RawSegment[];
    if (engine === 'scribe-v2') {
      keyterms = keytermsFor(opts.lexicon, KEYTERM_LIMITS['scribe-v2']);
      segments = await runScribe(audioPath, model, keyterms, opts.rawDumpDir);
    } else if (engine === 'assemblyai') {
      keyterms = keytermsFor(opts.lexicon, KEYTERM_LIMITS.assemblyai);
      segments = await runAssemblyAI(audioPath, model, keyterms, opts.rawDumpDir);
    } else {
      segments = await runOpenAI(audioPath, model, opts.rawDumpDir);
    }
    const mapping = await mapSpeakers(segments);
    rawSpeakerMap = mapping.map;
    speakerMapMethod = mapping.method;
    transcript = segments.map((s) => ({
      speaker: mapping.map[s.rawSpeaker] || s.rawSpeaker,
      text: s.text,
      timestamp: round2(s.start),
    }));
  }

  const elapsedMs = Date.now() - start;
  const counts = computeWordCounts(transcript);
  const cost = estimateCost(engine, opts.durationSec ?? null, counts.wordCount, keyterms.length);
  return {
    engine,
    model,
    transcript,
    counts,
    rawSpeakerMap,
    speakerMapMethod,
    keytermCount: keyterms.length,
    elapsedMs,
    estimatedCostUsd: cost.usd,
    costNote: cost.note,
  };
}
