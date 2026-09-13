/**
 * The ONE remaining Gemini call: image generation. Everything that used to be
 * a Gemini text call (transcription, story analysis, prompt writing, storyboard
 * planning, description merging, the World DNA essay) is now done by the
 * Claude Code agent driving the tools, or by ElevenLabs Scribe (audio).
 *
 * FAKE_GEMINI=1 stubs image generation with solid-color placeholders (and the
 * transcription call in lib/asr.ts) so the pipeline can be exercised
 * end-to-end without API spend.
 */
import { GoogleGenAI } from '@google/genai';

const FAKE = !!process.env.FAKE_GEMINI && process.env.FAKE_GEMINI !== '0';
const fakeDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAKE_IMAGE_COLORS = ['#b8860b', '#4a6fa5', '#6b8e23'];
let fakeImageCounter = 0;
async function fakeImageDataUrl(dims?: { w: number; h: number }): Promise<string> {
  const { default: sharp } = await import('sharp');
  const color = FAKE_IMAGE_COLORS[fakeImageCounter++ % FAKE_IMAGE_COLORS.length];
  const n = fakeImageCounter;
  const w = dims?.w ?? 1280, h = dims?.h ?? 720;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="${color}"/>
    <text x="${w / 2}" y="${h / 2}" font-size="${Math.round(Math.min(w, h) / 6)}" fill="white" text-anchor="middle" font-family="sans-serif">FAKE ${n}</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Override via GEMINI_IMAGE_MODEL in .env if the default is no longer valid.
export const imageModel = () => process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';

export function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (add it to tools/.env).');
  return new GoogleGenAI({ apiKey });
}

export interface RefImage {
  data: string;
  mimeType: string;
  type: string;
  name: string;
  description?: string;
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

/** Optional knobs for `generateImageFromPrompt`. Defaults preserve the original
 *  behavior (16:9 @ 1K, house pen-and-ink style trailer, no conditioning image). */
export interface ImageGenOptions {
  /** Gemini aspect ratio, e.g. '16:9' (default) | '3:4' | '1:1'. */
  aspectRatio?: string;
  /** Largest-dimension size hint: '1K' (default) | '2K' | '4K'. */
  imageSize?: string;
  /** Emit the prompt verbatim, skipping the house Style/Avoid trailer. */
  plainPrompt?: boolean;
  /** A single conditioning image (e.g. a layout sketch) attached first, with an
   *  instruction prepended to the prompt describing how to use it. */
  conditionImage?: { data: string; mimeType: string; instruction: string };
}

/** Fake-mode dimensions derived from aspect ratio + size (largest dimension). */
function fakeDims(opts: ImageGenOptions): { w: number; h: number } {
  const [aw, ah] = (opts.aspectRatio || '16:9').split(':').map(Number);
  const longest = ({ '1K': 1024, '2K': 2048, '4K': 4096 } as Record<string, number>)[opts.imageSize || '1K'] || 1024;
  return aw >= ah
    ? { w: longest, h: Math.round((longest * ah) / aw) }
    : { w: Math.round((longest * aw) / ah), h: longest };
}

const toImageParts = (images: RefImage[]) =>
  images.map((img) => ({ inlineData: { data: img.data, mimeType: img.mimeType } }));

/** Returns a data URL (data:image/png;base64,...) or null. */
export async function generateImageFromPrompt(
  prompt: string,
  entityImages: RefImage[] = [],
  retries = 1,
  frameRefs: FrameRef[] = [],
  opts: ImageGenOptions = {},
): Promise<string | null> {
  if (FAKE) {
    await fakeDelay(1000);
    return fakeImageDataUrl(opts.aspectRatio || opts.imageSize ? fakeDims(opts) : undefined);
  }
  const ai = getAI();
  const condParts = opts.conditionImage
    ? [{ inlineData: { data: opts.conditionImage.data, mimeType: opts.conditionImage.mimeType } }]
    : [];
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
  const condInstruction = opts.conditionImage ? `${opts.conditionImage.instruction}\n\n` : '';
  const text = opts.plainPrompt
    ? `${condInstruction}${prompt}`
    : `${condInstruction}${referenceMapping}${frameMapping}${prompt}
            Style: Whimsical, family-friendly, black and white pen and ink line illustration. Render a complete scene, but keep the background relatively simple and uncluttered so the characters stand out.
            Avoid: Any violence, adult themes, complex/realistic human faces, overly busy or densely cluttered backgrounds, or specific copyrighted characters (like Mickey or Minnie Mouse).`;
  try {
    const response = await ai.models.generateContent({
      model: imageModel(),
      contents: {
        parts: [...condParts, ...imageParts, ...frameParts, { text }],
      },
      config: {
        imageConfig: { aspectRatio: opts.aspectRatio ?? '16:9', imageSize: opts.imageSize ?? '1K' },
      },
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
      return generateImageFromPrompt(prompt, entityImages, retries - 1, frameRefs, opts);
    }
    throw err;
  }
}
