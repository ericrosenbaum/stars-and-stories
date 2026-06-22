import { GoogleGenAI, Type } from '@google/genai';
import type { TranscriptItem, HighlightQuote } from './types.ts';

// Model ids are inherited from the original AI Studio pipeline. If they are no
// longer valid, override via GEMINI_TEXT_MODEL / GEMINI_IMAGE_MODEL in .env.
const textModel = () => process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';
const imageModel = () => process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';

function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (add it to tools/.env).');
  return new GoogleGenAI({ apiKey });
}

export interface StoryAnalysis {
  title: string;
  transcript: TranscriptItem[];
  characters: { name: string; description: string }[];
  places: { name: string; description: string }[];
  summary: string;
  highlightQuote?: { text: string; timestamp: number };
}

export async function transcribeAndAnalyze(
  audioBase64: string,
  mimeType: string,
  retries = 2,
): Promise<StoryAnalysis> {
  const ai = getAI();
  try {
    const response = await ai.models.generateContent({
      model: textModel(),
      contents: [
        {
          parts: [
            { inlineData: { data: audioBase64, mimeType: mimeType || 'audio/mp4' } },
            {
              text: `Transcribe this storytelling session between a parent and a child.
              The speakers are always "Dad" (the father) and "Izzy" (his daughter Isabella).
              Please use these exact labels for the speakers.

              To improve transcription accuracy, please be aware of these recurring character names and ensure they are spelled correctly:
              Seeker, Dimitar, Mergirls, Hattie the Mouse, Disco and Thisco, Frasgle, Icicle

              Also:
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

              Return the result in JSON format with the following structure:
              {
                "title": "string",
                "transcript": [{"speaker": "string", "text": "string", "timestamp": number}],
                "characters": [{"name": "string", "description": "string"}],
                "places": [{"name": "string", "description": "string"}],
                "summary": "string (max 1000 chars)",
                "highlightQuote": {"text": "string (max 500 chars)", "timestamp": number}
              }

              CRITICAL: The timestamp MUST be the exact start time in seconds for each line, as a floating point number (e.g., 12.34). Be as precise as possible.`,
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
          required: ['title', 'transcript', 'characters', 'places', 'summary', 'highlightQuote'],
        },
      },
    });

    const text = response.text;
    if (!text) throw new Error('No response from Gemini');
    return JSON.parse(text) as StoryAnalysis;
  } catch (err: any) {
    const code = err?.error?.code || err?.code;
    const message = err?.error?.message || err?.message;
    if ((code === 500 || code === 503 || code === 504 || message?.includes('Deadline expired')) && retries > 0) {
      console.log(`Transcription returned ${code || 'timeout'}. Retrying... (${retries} left)`);
      await new Promise((r) => setTimeout(r, 3000));
      return transcribeAndAnalyze(audioBase64, mimeType, retries - 1);
    }
    throw err;
  }
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

export async function generateImagePrompt(
  summary: string,
  transcript: TranscriptItem[] = [],
  entityImages: RefImage[] = [],
): Promise<string> {
  const ai = getAI();
  const imageParts = entityImages.map((img) => ({
    inlineData: { data: img.data, mimeType: img.mimeType },
  }));
  const entityDescriptions = entityImages
    .map((e) => `- ${e.name}${e.description ? `: ${e.description}` : ''}`)
    .join('\n');

  const referenceBlock = entityImages.length
    ? `Reference Images:
            The attached images are visual references for these characters (in the same order):
            ${entityDescriptions}

            CRITICAL REFERENCE RULE: For any of the characters listed above that you mention in your prompt, you MUST append the exact phrase "(as in the image reference)" immediately after the character's name (for example: "Seeker (as in the image reference) stands beside a glowing lantern"). This keeps them visually consistent with the attached reference images. Do NOT use this phrase for any character that is not in the list above.`
    : '';

  const response = await ai.models.generateContent({
    model: textModel(),
    contents: [
      {
        parts: [
          ...imageParts,
          {
            text: `You are an art director specializing in clean, evocative illustrations. Based on the following story summary, transcript, and reference images, select ONE particularly interesting and visually striking scene from the story to illustrate.

            The goal is to create a beautiful header image that captures the atmosphere of a specific moment.

            Style Requirement: "A stylish black and white pen and ink illustration on a white background. Use elegant, clean line work. Avoid overly busy or dense textures, but ensure the scene feels complete."

            Directives:
            1. CHOOSE ONE SCENE: Pick a single specific moment or interaction that captures the mood of the story.
            2. COMPLETE COMPOSITION: Illustrate a whole scene including the subjects and their immediate surroundings, rather than just isolated floating elements.
            3. CLARITY: Focus on a strong, central composition. Use simplicity to ensure the subjects stand out, but don't shy away from depicting the environment of the chosen scene.

            Story Summary: ${summary}

            ${referenceBlock}

            Transcript Snippet (for context): ${JSON.stringify(transcript.slice(0, 20))}

            The prompt should describe this single scene in visual terms, focusing on the arrangement of characters, objects, and setting. Incorporate visual elements from the reference images to maintain character consistency.

            CRITICAL SAFETY RULE: Never use copyrighted names or specific trademarked characters in the prompt.
            Specifically, if "Mickey Mouse" or "Minnie Mouse" are mentioned in the story, replace them with descriptive terms like "a cheerful cartoon mouse" or "a friendly animated mouse".

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

/** Returns a data URL (data:image/png;base64,...) or null. */
export async function generateImageFromPrompt(
  prompt: string,
  entityImages: RefImage[] = [],
  retries = 1,
): Promise<string | null> {
  const ai = getAI();
  const imageParts = entityImages.map((img) => ({
    inlineData: { data: img.data, mimeType: img.mimeType },
  }));
  try {
    const response = await ai.models.generateContent({
      model: imageModel(),
      contents: {
        parts: [
          ...imageParts,
          {
            text: `${prompt}
            Style: Whimsical, artistic, family-friendly, black and white pen and ink illustration.
            Avoid: Any violence, adult themes, complex human faces, or specific copyrighted characters (like Mickey or Minnie Mouse). Focus on scenery, animals, or symbolic objects.`,
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
      return generateImageFromPrompt(prompt, entityImages, retries - 1);
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
