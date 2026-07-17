import fs from 'node:fs';
import { GoogleGenAI, Type } from '@google/genai';
import type { TranscriptItem, HighlightQuote } from './types.ts';
import type { NameLexicon } from './lexicon.ts';
import { recoverQuoteTimestamp } from './quote.ts';

// FAKE_GEMINI=1 stubs the three functions the add-story/studio flow calls, so
// the whole pipeline (upload, entity merge, candidates lifecycle, build, git)
// can be exercised end-to-end without API spend. Everything else stays real.
const FAKE = !!process.env.FAKE_GEMINI && process.env.FAKE_GEMINI !== '0';
const fakeDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeAnalysis(): StoryAnalysis {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '-'); // unique slug per run
  return {
    title: `Fake Story ${stamp}`,
    transcript: [
      { speaker: 'Dad', text: 'Once upon a time there was a fake story.', timestamp: 0.5 },
      { speaker: 'Izzy', text: 'And it was generated without any API calls!', timestamp: 4.2 },
      { speaker: 'Dad', text: 'Seeker appeared, exactly as always.', timestamp: 8.9 },
      { speaker: 'Izzy', text: 'Then the Testing Turtle showed up for the first time.', timestamp: 13.1 },
      { speaker: 'Dad', text: 'The end.', timestamp: 17.7 },
    ],
    characters: [
      { name: 'Seeker', description: 'A recurring seeker of things.' }, // exercises the existing-entity merge
      { name: 'Testing Turtle', description: 'A brand-new turtle who only exists in fake mode.' },
    ],
    places: [{ name: 'The Fake Forest', description: 'A forest of stubs and mocks.' }],
    summary: 'A tiny fake story used to exercise the pipeline without calling Gemini.',
    highlightQuote: { text: 'And it was generated without any API calls!', timestamp: 4.2 },
  };
}

const FAKE_IMAGE_COLORS = ['#b8860b', '#4a6fa5', '#6b8e23'];
let fakeImageCounter = 0;
async function fakeImageDataUrl(): Promise<string> {
  const { default: sharp } = await import('sharp');
  const color = FAKE_IMAGE_COLORS[fakeImageCounter++ % FAKE_IMAGE_COLORS.length];
  const n = fakeImageCounter;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <rect width="1280" height="720" fill="${color}"/>
    <text x="640" y="380" font-size="120" fill="white" text-anchor="middle" font-family="sans-serif">FAKE ${n}</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Model ids are inherited from the original AI Studio pipeline. If they are no
// longer valid, override via GEMINI_TEXT_MODEL / GEMINI_IMAGE_MODEL in .env.
const textModel = () => process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';
const imageModel = () => process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
// The audio pass can run on a different (stronger) model than the text calls.
export const transcribeModel = () =>
  process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';

export function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (add it to tools/.env).');
  return new GoogleGenAI({ apiKey });
}

/** Retry `fn` on transient Gemini errors (5xx / deadline), like the old
 * transcribe-and-analyze call did — both passes need this so a blip in the
 * cheap analysis call can't throw away a completed (paid) transcription. */
async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 2): Promise<T> {
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const code = err?.error?.code || err?.code;
      const message = err?.error?.message || err?.message;
      if ((code === 500 || code === 503 || code === 504 || message?.includes('Deadline expired')) && retries > 0) {
        console.log(`${label} returned ${code || 'timeout'}. Retrying... (${retries} left)`);
        retries -= 1;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

// Inline audio must stay within the API's 20 MB request cap AFTER base64
// inflation (4/3x): 14 MiB of audio -> ~19.6 MB encoded, leaving room for the
// prompt. Bigger files go through the Files API.
const INLINE_AUDIO_LIMIT = 14 * 1024 * 1024;

async function audioPart(
  ai: GoogleGenAI,
  audioPath: string,
  mimeType: string,
): Promise<{ part: object; cleanup: () => Promise<void> }> {
  const size = fs.statSync(audioPath).size;
  if (size <= INLINE_AUDIO_LIMIT) {
    return {
      part: { inlineData: { data: fs.readFileSync(audioPath).toString('base64'), mimeType } },
      cleanup: async () => {},
    };
  }
  console.log(`  (audio is ${(size / 1024 / 1024).toFixed(1)} MB — uploading via the Files API)`);
  let file = await ai.files.upload({ file: audioPath, config: { mimeType } });
  const deadline = Date.now() + 120_000;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('Files API upload timed out while processing.');
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name: file.name! });
  }
  if (file.state === 'FAILED') throw new Error('Files API upload failed to process the audio.');
  return {
    part: { fileData: { fileUri: file.uri!, mimeType } },
    cleanup: async () => {
      try {
        await ai.files.delete({ name: file.name! });
      } catch {
        /* best-effort; uploads expire on their own */
      }
    },
  };
}

function lexiconBlock(lexicon?: NameLexicon): string {
  if (!lexicon || (!lexicon.characters.length && !lexicon.places.length)) return '';
  return `NAME LEXICON: These character and place names recur across their stories. If you hear a name that sounds like one of these, use this exact spelling:
              Characters: ${lexicon.characters.join(', ')}
              Places: ${lexicon.places.join(', ')}
              Only use a lexicon name when it genuinely matches what was said — new names are common and should be transcribed as heard.

              `;
}

export interface TranscribeOptions {
  model?: string; // overrides GEMINI_TRANSCRIBE_MODEL
  lexicon?: NameLexicon;
  retries?: number;
}

/**
 * Pass 1: audio -> diarized transcript. Deliberately does nothing else — a
 * focused prompt labels speakers and places timestamps better than the old
 * transcribe-and-analyze-everything single call.
 */
export async function transcribeAudio(
  audioPath: string,
  mimeType = 'audio/mp4',
  opts: TranscribeOptions = {},
): Promise<TranscriptItem[]> {
  const ai = getAI();
  const model = opts.model || transcribeModel();
  const { part, cleanup } = await audioPart(ai, audioPath, mimeType);
  try {
    return await withRetry(
      'Transcription',
      async () => {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              parts: [
                part,
                {
                  text: `Transcribe this audio recording of a storytelling session between a father and his young daughter. Your ONLY job is a verbatim transcript with accurate speaker labels and timestamps. Do not summarize or analyze.

              SPEAKERS — there are exactly two voices:
              - "Dad" — the adult male voice (the father).
              - "Izzy" — the young child's voice (his daughter Isabella).
              Label every line with exactly "Dad" or "Izzy". Identify the speaker primarily by the ACOUSTIC quality of the voice (adult male vs. young child), not by what is being said — either speaker may narrate, ask questions, or voice characters. When one speaker imitates the other or performs a character voice, still label the line by whose voice is physically speaking.

              CHILD SPEECH: Izzy is a young child. She may mispronounce words, speak quickly or quietly, trail off, or invent words. Listen carefully and transcribe her intended words in standard spelling. When she clearly invents a nonsense word or name, transcribe it phonetically and consistently. Never drop her short interjections — her lines matter as much as Dad's.

              ${lexiconBlock(opts.lexicon)}SEGMENTATION AND TIMESTAMPS:
              - Start a new transcript line on every speaker change; also break long monologues at natural sentence boundaries (roughly every 1-3 sentences).
              - "timestamp" is the time in SECONDS from the start of the audio at which the line begins, as a floating point number (e.g. 12.34). Timestamps must be non-decreasing and as precise as possible.

              Return JSON: { "transcript": [{ "speaker": "Dad" | "Izzy", "text": string, "timestamp": number }] }`,
                },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                transcript: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      speaker: { type: Type.STRING },
                      text: { type: Type.STRING },
                      timestamp: { type: Type.NUMBER },
                    },
                    required: ['speaker', 'text', 'timestamp'],
                  },
                },
              },
              required: ['transcript'],
            },
          },
        });

        const text = response.text;
        if (!text) throw new Error('No response from Gemini');
        const transcript = (JSON.parse(text) as { transcript: TranscriptItem[] }).transcript;
        if (!transcript?.length) throw new Error('Gemini returned an empty transcript.');
        return transcript;
      },
      opts.retries ?? 2,
    );
  } finally {
    await cleanup();
  }
}

export interface TranscriptAnalysis {
  title: string;
  characters: { name: string; description: string }[];
  places: { name: string; description: string }[];
  summary: string;
  highlightQuote?: { text: string; timestamp: number };
}

export interface StoryAnalysis extends TranscriptAnalysis {
  transcript: TranscriptItem[];
}

/**
 * FAKE_GEMINI dev mode: canned transcript + analysis so the studio/add pipeline
 * runs end-to-end without any transcription/analysis API spend. Returns null
 * when FAKE mode is off. Image generation is stubbed separately in the
 * candidate/image functions below.
 */
export function maybeFakeAnalysis(): StoryAnalysis | null {
  return FAKE ? fakeAnalysis() : null;
}

/** Pass 2: transcript text -> title, entities, summary, highlight quote. */
export async function analyzeTranscript(
  transcript: TranscriptItem[],
  opts: { model?: string } = {},
): Promise<TranscriptAnalysis> {
  const ai = getAI();
  return withRetry('Analysis', async () => {
  const response = await ai.models.generateContent({
    model: opts.model || textModel(),
    contents: [
      {
        parts: [
          {
            text: `Here is the transcript of a storytelling session between "Dad" (the father) and "Izzy" (his young daughter Isabella):

              ${JSON.stringify(transcript)}

              1. Generate a creative and catchy title for this story session.
              2. Extract all unique characters and places mentioned in the story.
                 IMPORTANT: Each entry MUST be a single individual character or place.
                 Do NOT group multiple characters together (e.g., "Ginger, Garfield, and Alexander" is WRONG).
                 Instead, return three separate entries: "Ginger", "Garfield", and "Alexander".
                 ONLY use a group name if it is a specific named group in the story (e.g., "The Floofers").
              3. Provide a short summary of the story.
                 IMPORTANT: Focus ONLY on the narrative of the story itself.
                 Do NOT include meta-commentary about the storytelling session (e.g., omit phrases like "Dad and Izzy tell a story", "In this session", or mentions of the father and daughter narrating).
                 The summary should read like a blurb for a book or a movie.
              4. Find a short, memorable quote from "Izzy" that is especially funny, clever, unusual, or interesting.
                 It should be a specific moment that captures her personality or a key moment in the story.
                 Copy the quote's "timestamp" from the transcript line the quote comes from.

              Return the result in JSON format with the following structure:
              {
                "title": "string",
                "characters": [{"name": "string", "description": "string"}],
                "places": [{"name": "string", "description": "string"}],
                "summary": "string (max 1000 chars)",
                "highlightQuote": {"text": "string (max 500 chars)", "timestamp": number}
              }`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          characters: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { name: { type: Type.STRING }, description: { type: Type.STRING } },
              required: ['name', 'description'],
            },
          },
          places: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { name: { type: Type.STRING }, description: { type: Type.STRING } },
              required: ['name', 'description'],
            },
          },
          summary: { type: Type.STRING },
          highlightQuote: {
            type: Type.OBJECT,
            properties: { text: { type: Type.STRING }, timestamp: { type: Type.NUMBER } },
            required: ['text', 'timestamp'],
          },
        },
        required: ['title', 'characters', 'places', 'summary', 'highlightQuote'],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error('No response from Gemini');
  return JSON.parse(text) as TranscriptAnalysis;
  });
}

/** Transcribe (pass 1) then analyze (pass 2). Same result shape as before. */
export async function transcribeAndAnalyze(
  audioPath: string,
  mimeType = 'audio/mp4',
  opts: { lexicon?: NameLexicon } = {},
): Promise<StoryAnalysis> {
  const fake = maybeFakeAnalysis();
  if (fake) {
    await fakeDelay(2000);
    return fake;
  }
  const transcript = await transcribeAudio(audioPath, mimeType, { lexicon: opts.lexicon });
  console.log(`  transcript: ${transcript.length} lines. Analyzing...`);
  const analysis = await analyzeTranscript(transcript);
  // The analysis model only copies timestamps from transcript text — anchor
  // the quote to the actual transcript line when one matches, since the
  // schema forces a numeric timestamp even when the model guesses.
  if (analysis.highlightQuote?.text) {
    const recovered = recoverQuoteTimestamp(analysis.highlightQuote.text, transcript);
    if (recovered != null) analysis.highlightQuote.timestamp = recovered;
  }
  return { ...analysis, transcript };
}

export async function extractHighlightQuote(
  transcript: TranscriptItem[],
  excludeQuote?: string,
): Promise<HighlightQuote | null> {
  const ai = getAI();
  const avoidSection = excludeQuote
    ? `- The existing quote: "${excludeQuote}" (CRITICAL: DO NOT return this exact quote again, find a DIFFERENT one).`
    : '';

  const response = await ai.models.generateContent({
    model: textModel(),
    contents: [
      {
        parts: [
          {
            text: `From the following transcript of a storytelling session between "Dad" and "Izzy", find a short, memorable quote from "Izzy" that is especially funny, clever, unusual, or interesting.
            It should be a specific moment that captures her personality, a surprising plot twist she introduces, or an evocative description.

            AVOID:
            ${avoidSection}
            - Generic filler phrases like "keep telling the story and then you'll find out" or "I don't know yet".
            - Meta-commentary about the recording itself.
            - Simple "yes" or "no" answers.
            - Fragments that don't make sense out of context.

            PREFER:
            - Weird or wonderful things she says.
            - Specific names of characters or magical things.
            - Expressive or emotional outbursts.

            Transcript:
            ${JSON.stringify(transcript)}

            Return the result in JSON format with the following structure:
            {
              "text": "string",
              "timestamp": number
            }

            CRITICAL: The timestamp MUST be the exact start time in seconds for the quote, as a floating point number (e.g., 12.34). Be as precise as possible.`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING }, timestamp: { type: Type.NUMBER } },
        required: ['text', 'timestamp'],
      },
    },
  });

  const text = response.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as HighlightQuote;
  } catch {
    return null;
  }
}

export async function mergeEntityDescription(oldDesc: string, newInfo: string): Promise<string> {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: textModel(),
    contents: [
      {
        parts: [
          {
            text: `You are a creative story world archivist.
            I have an existing description for a character or place, and some new information from a recent story.
            Please merge them into a single, cohesive, and evocative description.
            Keep it concise but rich in detail.

            Existing Description: ${oldDesc}
            New Information: ${newInfo}

            Return ONLY the new merged description text.`,
          },
        ],
      },
    ],
  });
  return response.text || oldDesc;
}

export async function extractOverallThemes(
  stories: { title: string; summary: string; date: string }[],
  characters: { name: string; description: string }[],
  places: { name: string; description: string }[],
): Promise<string> {
  if (stories.length === 0) return '';
  const ai = getAI();
  const sortedStories = [...stories].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const storiesText = sortedStories
    .map((s) => `[${s.date.split('T')[0]}] ${s.title}: ${s.summary}`)
    .join('\n\n');
  const charactersText = characters.map((c) => `- ${c.name}: ${c.description}`).join('\n');
  const placesText = places.map((p) => `- ${p.name}: ${p.description}`).join('\n');

  const response = await ai.models.generateContent({
    model: textModel(),
    contents: [
      {
        parts: [
          {
            text: `I have a collection of stories told by a father and his young daughter, Izzy, over time.
            The dates of the stories are provided.

            Key Characters:
            ${charactersText}

            Key Places:
            ${placesText}

            Stories in Chronological Order:
            ${storiesText}

            Please provide a deep, evocative analysis covering:
            1. THE ARCHETYPES & THEMES: What recurring symbols, magical rules, or emotional themes define this world?
            2. CHRONOLOGICAL EVOLUTION: How has the storytelling changed over time? Have certain characters or settings gained prominence or "eroded" away? Are there distinct "Eras" or "Phases" in their creative output?
            3. CHARACTER ARCS: How do the major characters evolve across different stories?
            4. THE SHARED DNA: What makes these stories uniquely "theirs"?

            Provide a meaningful, evocative analysis in several well-structured paragraphs.
            Use headers if appropriate.
            Focus on the "DNA" of their shared imaginary world.
            Keep it insightful and heartwarming, as this is a record of a childhood.
            Return ONLY the analysis text.`,
          },
        ],
      },
    ],
  });
  return response.text || 'No themes found yet.';
}

export interface RefImage {
  data: string;
  mimeType: string;
  type: string;
  name: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Shared building blocks for every image-prompt generator (single header
// prompt, header candidates, storyboard scenes) so the style and the
// reference-binding rules never drift apart between them.
// ---------------------------------------------------------------------------

const STYLE_REQUIREMENT = `Style Requirement: "A stylish black and white pen and ink illustration on a white background. Use elegant, clean line work. Render a complete scene, but keep the background relatively simple and uncluttered so the characters remain the clear focus. Avoid overly busy or dense textures."`;

const COPYRIGHT_RULE = `CRITICAL SAFETY RULE: Never use copyrighted names or specific trademarked characters in the prompt.
            Specifically, if "Mickey Mouse" or "Minnie Mouse" are mentioned in the story, replace them with descriptive terms like "a cheerful cartoon mouse" or "a friendly animated mouse".`;

const PROMPT_GUIDANCE = `The prompt should describe the scene in visual terms — the characters, the key objects and action, and a lightly-detailed setting that establishes the place without becoming busy. Incorporate visual elements from the reference images to maintain character consistency.`;

function buildReferenceBlock(entityImages: RefImage[]): string {
  if (!entityImages.length) return '';
  const entityDescriptions = entityImages
    .map((e) => `- ${e.name}${e.description ? `: ${e.description}` : ''}`)
    .join('\n');
  return `Reference Images:
            The attached images are visual references for these characters (in the same order):
            ${entityDescriptions}

            CRITICAL REFERENCE RULE: For EVERY one of the characters listed above that appears in a scene, you MUST (a) include them in the prompt and (b) append the exact phrase "(as in the image reference)" immediately after the character's name (for example: "Seeker (as in the image reference) stands beside a glowing lantern"). Apply this to each referenced character individually — do not skip any. Keep each such character's own description very brief (a few words at most) and rely on their reference image for their exact appearance rather than inventing conflicting details. Do NOT use this phrase for any character that is not in the list above.`;
}

const toImageParts = (images: RefImage[]) =>
  images.map((img) => ({ inlineData: { data: img.data, mimeType: img.mimeType } }));

export async function generateImagePrompt(
  summary: string,
  transcript: TranscriptItem[] = [],
  entityImages: RefImage[] = [],
): Promise<string> {
  const ai = getAI();
  const imageParts = toImageParts(entityImages);
  const referenceBlock = buildReferenceBlock(entityImages);

  const response = await ai.models.generateContent({
    model: textModel(),
    contents: [
      {
        parts: [
          ...imageParts,
          {
            text: `You are an art director specializing in clean, evocative illustrations. Based on the following story summary, transcript, and reference images, select ONE particularly interesting and visually striking scene from the story to illustrate.

            The goal is to create a beautiful header image that captures the atmosphere of a specific moment.

            ${STYLE_REQUIREMENT}

            Directives:
            1. CHOOSE ONE SCENE: Pick a single specific moment or interaction that captures the mood of the story.
            2. COMPLETE COMPOSITION: Illustrate a whole scene including the subjects and their immediate surroundings, rather than just isolated floating elements — but establish the setting with a few well-chosen details rather than densely rendering everything.
            3. CLARITY: Focus on a strong, central composition. Keep the main characters prominent and the background a little lighter and simpler so they stand out, while still conveying a clear sense of place.

            Story Summary: ${summary}

            ${referenceBlock}

            Transcript Snippet (for context): ${JSON.stringify(transcript.slice(0, 20))}

            ${PROMPT_GUIDANCE}

            ${COPYRIGHT_RULE}

            Return ONLY the generated prompt text.`,
          },
        ],
      },
    ],
  });
  return (
    response.text ||
    'A minimalist black and white pen and ink illustration of a single story scene with sparse composition.'
  );
}

/**
 * Generate several DISTINCT header-prompt candidates in one art-director call.
 * Each candidate depicts a different scene from the story, or a clearly
 * different composition of the story's most striking moment. `opts.feedback`
 * carries the user's notes from reviewing a previous candidate batch.
 */
export async function generateImagePromptCandidates(
  summary: string,
  transcript: TranscriptItem[] = [],
  entityImages: RefImage[] = [],
  opts: { count?: number; feedback?: string } = {},
): Promise<string[]> {
  const count = opts.count ?? 3;
  if (FAKE) {
    await fakeDelay(500);
    return Array.from({ length: count }, (_, i) => `Fake prompt ${i + 1}${opts.feedback ? ` (feedback: ${opts.feedback})` : ''}`);
  }
  const ai = getAI();
  const imageParts = toImageParts(entityImages);
  const referenceBlock = buildReferenceBlock(entityImages);
  const feedbackBlock = opts.feedback
    ? `USER FEEDBACK: The user reviewed a previous batch of candidate images and gave this feedback — it OVERRIDES the directives above wherever they conflict: "${opts.feedback}"`
    : '';

  const response = await ai.models.generateContent({
    model: textModel(),
    contents: [
      {
        parts: [
          ...imageParts,
          {
            text: `You are an art director specializing in clean, evocative illustrations. Based on the following story summary, transcript, and reference images, propose exactly ${count} DISTINCT candidate scenes to illustrate as the story's header image.

            Each candidate must be either a DIFFERENT specific moment from the story, or a clearly different composition/treatment of the story's most striking moment. Each prompt must be fully self-contained (do not refer to the other candidates).

            The goal is a beautiful header image that captures the atmosphere of a specific moment.

            ${STYLE_REQUIREMENT}

            Directives (apply to EACH candidate):
            1. ONE SCENE PER CANDIDATE: A single specific moment or interaction that captures the mood of the story.
            2. COMPLETE COMPOSITION: Illustrate a whole scene including the subjects and their immediate surroundings, rather than just isolated floating elements — but establish the setting with a few well-chosen details rather than densely rendering everything.
            3. CLARITY: Focus on a strong, central composition. Keep the main characters prominent and the background a little lighter and simpler so they stand out, while still conveying a clear sense of place.

            Story Summary: ${summary}

            ${referenceBlock}

            Transcript Snippet (for context): ${JSON.stringify(transcript.slice(0, 20))}

            ${PROMPT_GUIDANCE}

            ${COPYRIGHT_RULE}

            ${feedbackBlock}

            Return JSON: { "prompts": ["...", ...] } with exactly ${count} prompts.`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: { prompts: { type: Type.ARRAY, items: { type: Type.STRING } } },
        required: ['prompts'],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error('No response from Gemini when generating prompt candidates.');
  const prompts = (JSON.parse(text)?.prompts ?? []).filter(
    (p: unknown): p is string => typeof p === 'string' && p.trim().length > 0,
  );
  if (!prompts.length) throw new Error('Gemini returned no usable prompt candidates.');
  if (prompts.length < count) {
    console.warn(`  (asked for ${count} prompt candidates, got ${prompts.length})`);
  }
  return prompts.slice(0, count);
}

/** One scene of a storyboard plan, as returned by the planner. */
export interface StoryboardScenePlan {
  caption: string; // one-sentence summary of the action in this scene
  quoteSpeaker: string; // "Izzy" | "Dad"
  quoteText: string; // verbatim line from the transcript
  imagePrompt: string; // header-style pen-and-ink prompt with reference tags
}

/**
 * Plan an ordered storyboard for a whole story: a sequence of scenes that
 * together tell the entire story, favoring its interesting, funny, or unusual
 * moments. Receives the FULL transcript (unlike the header prompt).
 */
export async function generateStoryboardPlan(
  summary: string,
  transcript: TranscriptItem[],
  entityImages: RefImage[] = [],
  sceneCount?: number,
): Promise<StoryboardScenePlan[]> {
  const ai = getAI();
  const imageParts = toImageParts(entityImages);
  const referenceBlock = buildReferenceBlock(entityImages);
  const countDirective = sceneCount
    ? `Use exactly ${sceneCount} scenes.`
    : `Choose the number of scenes yourself — usually 6 to 12 — enough to tell the whole story without padding.`;

  const response = await ai.models.generateContent({
    model: textModel(),
    contents: [
      {
        parts: [
          ...imageParts,
          {
            text: `You are an art director creating a storyboard for a story told aloud by a father ("Dad") and his young daughter ("Izzy"). Break the story into an ordered sequence of scenes that together tell the WHOLE story coherently from beginning to end. ${countDirective} Make sure to include the story's most interesting, funny, or unusual moments.

            For EACH scene provide:
            1. "caption": ONE sentence, present tense, summarizing the action of that scene.
            2. "quoteSpeaker" and "quoteText": a short, direct quote from the transcript for that moment — copied VERBATIM, character for character, from a single transcript line. Prefer funny, surprising, or characterful lines, especially Izzy's. Do not paraphrase, merge lines, or invent dialogue.
            3. "imagePrompt": a prompt to illustrate the scene, following the style and reference rules below. Each prompt must be fully self-contained.

            ${STYLE_REQUIREMENT}

            Composition directives for each imagePrompt: illustrate a whole scene including the subjects and their immediate surroundings; establish the setting with a few well-chosen details; keep the main characters prominent and the background lighter and simpler so they stand out.

            Story Summary: ${summary}

            ${referenceBlock}

            Full Transcript: ${JSON.stringify(transcript)}

            ${PROMPT_GUIDANCE}

            ${COPYRIGHT_RULE}`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          scenes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                caption: { type: Type.STRING },
                quoteSpeaker: { type: Type.STRING },
                quoteText: { type: Type.STRING },
                imagePrompt: { type: Type.STRING },
              },
              required: ['caption', 'quoteSpeaker', 'quoteText', 'imagePrompt'],
            },
          },
        },
        required: ['scenes'],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error('No response from Gemini when planning the storyboard.');
  const scenes: StoryboardScenePlan[] = JSON.parse(text)?.scenes ?? [];
  if (!scenes.length) throw new Error('Gemini returned an empty storyboard plan.');
  return scenes.slice(0, 16);
}

/**
 * A previously generated storyboard frame attached as a continuity reference
 * for later frames (so recurring elements stay consistent across the sequence).
 */
export interface FrameRef {
  data: string;
  mimeType: string;
  label: string;
}

/** Returns a data URL (data:image/png;base64,...) or null. */
export async function generateImageFromPrompt(
  prompt: string,
  entityImages: RefImage[] = [],
  retries = 1,
  frameRefs: FrameRef[] = [],
): Promise<string | null> {
  if (FAKE) {
    await fakeDelay(1000);
    return fakeImageDataUrl();
  }
  const ai = getAI();
  const imageParts = toImageParts(entityImages);
  const frameParts = frameRefs.map((f) => ({
    inlineData: { data: f.data, mimeType: f.mimeType },
  }));
  // Bind each attached reference image to its character by name and position, so
  // the model applies the right reference to the right character instead of
  // guessing (which previously left some characters off-model).
  const referenceMapping = entityImages.length
    ? `The first ${entityImages.length} attached reference image(s) show these characters, in this exact order:
${entityImages.map((e, i) => `${i + 1}. ${e.name}`).join('\n')}
Render EACH of these characters to closely match their OWN reference image (face, body shape, colors, clothing/markings). When the scene text tags a character with "(as in the image reference)", match that specific numbered reference above. Do not blend or swap appearances between characters, and do not leave any tagged character off-model.

`
    : '';
  const frameMapping = frameRefs.length
    ? `The next ${frameRefs.length} attached image(s) are PREVIOUS STORYBOARD FRAMES from this same story, in order:
${frameRefs.map((f, i) => `${i + 1}. ${f.label}`).join('\n')}
They are for CONTINUITY ONLY: keep recurring characters, props, art style, and settings consistent with how they appear in those frames — but draw the NEW scene described below, not a copy of those frames.

`
    : '';
  try {
    const response = await ai.models.generateContent({
      model: imageModel(),
      contents: {
        parts: [
          ...imageParts,
          ...frameParts,
          {
            text: `${referenceMapping}${frameMapping}${prompt}
            Style: Whimsical, family-friendly, black and white pen and ink line illustration. Render a complete scene, but keep the background relatively simple and uncluttered so the characters stand out.
            Avoid: Any violence, adult themes, complex/realistic human faces, overly busy or densely cluttered backgrounds, or specific copyrighted characters (like Mickey or Minnie Mouse).`,
          },
        ],
      },
      config: { imageConfig: { aspectRatio: '16:9', imageSize: '1K' } },
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
    return null;
  } catch (err: any) {
    const code = err?.error?.code || err?.code;
    const message = err?.error?.message || err?.message;
    if ((code === 503 || code === 504 || message?.includes('Deadline expired')) && retries > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return generateImageFromPrompt(prompt, entityImages, retries - 1, frameRefs);
    }
    throw err;
  }
}

export async function generateStoryHeaderImage(
  summary: string,
  transcript: TranscriptItem[] = [],
  entityImages: RefImage[] = [],
): Promise<string | null> {
  const prompt = await generateImagePrompt(summary, transcript, entityImages);
  return generateImageFromPrompt(prompt, entityImages);
}
