/** Smoke-test the configured Gemini model names against the live API. */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY || '';
const textModel = process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash';
const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';

if (!apiKey) {
  console.error('GEMINI_API_KEY not set in tools/.env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function checkText(model: string) {
  try {
    const res = await ai.models.generateContent({ model, contents: 'Reply with the single word: ok' });
    console.log(res.text ? `✓ text model "${model}" works` : `✗ text model "${model}" responded with no text`);
  } catch (e: any) {
    console.log(`✗ text model "${model}" FAILED: ${e?.message || e}`);
  }
}

async function checkImage(model: string) {
  try {
    const res = await ai.models.generateContent({
      model,
      contents: { parts: [{ text: 'A simple black and white pen and ink line drawing of a single star.' }] },
      config: { imageConfig: { aspectRatio: '16:9', imageSize: '1K' } },
    });
    const ok = res.candidates?.[0]?.content?.parts?.some((p: any) => p.inlineData);
    console.log(ok ? `✓ image model "${model}" works` : `✗ image model "${model}" returned no image`);
  } catch (e: any) {
    console.log(`✗ image model "${model}" FAILED: ${e?.message || e}`);
  }
}

async function checkElevenLabs() {
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    });
    console.log(res.ok ? '✓ ElevenLabs API key works' : `✗ ElevenLabs API key FAILED (HTTP ${res.status})`);
  } catch (e: any) {
    console.log(`✗ ElevenLabs check FAILED: ${e?.message || e}`);
  }
}

async function checkOpenAI(model: string) {
  try {
    const res = await fetch(`https://api.openai.com/v1/models/${model}`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    console.log(
      res.ok ? `✓ OpenAI model "${model}" works` : `✗ OpenAI key or model "${model}" FAILED (HTTP ${res.status})`,
    );
  } catch (e: any) {
    console.log(`✗ OpenAI check FAILED: ${e?.message || e}`);
  }
}

await checkText(textModel);
await checkImage(imageModel);
const transcribeModel = process.env.GEMINI_TRANSCRIBE_MODEL;
if (transcribeModel && transcribeModel !== textModel) await checkText(transcribeModel);
if (process.env.ELEVENLABS_API_KEY) await checkElevenLabs();
if (process.env.OPENAI_API_KEY) await checkOpenAI(process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe-diarize');
console.log('\nIf a model failed, set GEMINI_TEXT_MODEL / GEMINI_IMAGE_MODEL / GEMINI_TRANSCRIBE_MODEL in tools/.env to a current model id.');
