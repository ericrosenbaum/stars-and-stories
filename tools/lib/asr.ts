/**
 * Transcription engine registry for the bake-off and retranscribe tools.
 * Every engine returns the same normalized TranscriptItem[] with speakers
 * already mapped to "Dad"/"Izzy" so downstream word counts and the site
 * work regardless of which engine produced the transcript.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@google/genai';
import { getAI, transcribeAudio } from './gemini.ts';
import { countWords } from './wordcount.ts';
import type { NameLexicon } from './lexicon.ts';
import type { TranscriptItem } from './types.ts';

export type EngineId = 'gemini-flash' | 'gemini-pro' | 'scribe-v2' | 'openai-diarize';
export const ALL_ENGINES: EngineId[] = ['gemini-flash', 'gemini-pro', 'scribe-v2', 'openai-diarize'];

export interface EngineResult {
  engine: EngineId;
  model: string; // resolved model id
  transcript: TranscriptItem[]; // speakers already mapped to Dad/Izzy
  rawSpeakerMap?: Record<string, string>; // e.g. { speaker_0: 'Dad' } (acoustic engines only)
  speakerMapMethod?: 'gemini' | 'word-share'; // how the raw labels were mapped
  elapsedMs: number;
  estimatedCostUsd: number | null;
  costNote: string; // the formula used, so estimates are auditable
}

export function engineModel(engine: EngineId): string {
  switch (engine) {
    case 'gemini-flash':
      return process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';
    case 'gemini-pro':
      return process.env.GEMINI_PRO_MODEL || 'gemini-3.5-pro';
    case 'scribe-v2':
      return process.env.ELEVENLABS_STT_MODEL || 'scribe_v2';
    case 'openai-diarize':
      return process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe-diarize';
  }
}

export function engineAvailable(engine: EngineId): { ok: boolean; reason?: string } {
  if (engine === 'scribe-v2') {
    return process.env.ELEVENLABS_API_KEY ? { ok: true } : { ok: false, reason: 'ELEVENLABS_API_KEY not set' };
  }
  if (engine === 'openai-diarize') {
    return process.env.OPENAI_API_KEY ? { ok: true } : { ok: false, reason: 'OPENAI_API_KEY not set' };
  }
  return process.env.GEMINI_API_KEY || process.env.API_KEY
    ? { ok: true }
    : { ok: false, reason: 'GEMINI_API_KEY not set' };
}

// Pricing as of 2026-07 — spot-check against the providers' pricing pages
// before trusting an estimate to the cent. Gemini audio is billed at 32
// tokens/second of input; the per-token audio rates below are the least
// certain numbers here (Google's audio rate differs from the text rate).
const GEMINI_AUDIO_TOKENS_PER_SEC = 32;
const PRICING = {
  'gemini-flash': { audioInPerM: 1.0, outPerM: 3.0 },
  'gemini-pro': { audioInPerM: 2.0, outPerM: 12.0 },
  'scribe-v2': { perHour: 0.22 },
  'openai-diarize': { perMinute: 0.006 },
} as const;

export function estimateCost(
  engine: EngineId,
  durationSec: number | null,
  transcriptWords = 0,
): { usd: number | null; note: string } {
  if (durationSec == null || !isFinite(durationSec) || durationSec <= 0) {
    return { usd: null, note: 'audio duration unknown — no estimate' };
  }
  const min = durationSec / 60;
  if (engine === 'scribe-v2') {
    const usd = (durationSec / 3600) * PRICING[engine].perHour;
    return { usd, note: `${min.toFixed(1)} min × $${PRICING[engine].perHour}/hr` };
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

async function runScribe(audioPath: string, model: string, rawDumpDir?: string): Promise<RawSegment[]> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)], { type: 'audio/mp4' }), path.basename(audioPath));
  form.append('model_id', model);
  form.append('diarize', 'true');
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

async function runOpenAI(audioPath: string, model: string, rawDumpDir?: string): Promise<RawSegment[]> {
  const size = fs.statSync(audioPath).size;
  if (size > 25 * 1024 * 1024) {
    throw new Error(
      `Audio is ${(size / 1024 / 1024).toFixed(1)} MB, over OpenAI's 25 MB upload limit. ` +
        `Re-encode it smaller first: ffmpeg -i in.m4a -ac 1 -b:a 48k out.m4a`,
    );
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)], { type: 'audio/mp4' }), path.basename(audioPath));
  form.append('model', model);
  form.append('response_format', 'diarized_json');
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

  if (engine === 'gemini-flash' || engine === 'gemini-pro') {
    transcript = await transcribeAudio(audioPath, 'audio/mp4', { model, lexicon: opts.lexicon });
  } else {
    const segments =
      engine === 'scribe-v2'
        ? await runScribe(audioPath, model, opts.rawDumpDir)
        : await runOpenAI(audioPath, model, opts.rawDumpDir);
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
  const words = transcript.reduce((n, t) => n + countWords(t.text), 0);
  const cost = estimateCost(engine, opts.durationSec ?? null, words);
  return {
    engine,
    model,
    transcript,
    rawSpeakerMap,
    speakerMapMethod,
    elapsedMs,
    estimatedCostUsd: cost.usd,
    costNote: cost.note,
  };
}
