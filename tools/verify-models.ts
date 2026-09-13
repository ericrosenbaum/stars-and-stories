/** Smoke-test the configured API keys / model ids against the live APIs:
 * ElevenLabs (transcription), the Gemini image model (the only Gemini call
 * left), and OpenAI (bake-off only). Checks whichever keys are present in tools/.env. */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { imageModel } from './lib/gemini.ts';
import { engineModel } from './lib/asr.ts';

async function checkImage(ai: GoogleGenAI, model: string) {
  try {
    const res = await ai.models.generateContent({
      model,
      contents: { parts: [{ text: 'A simple black and white pen and ink line drawing of a single star.' }] },
      config: { imageConfig: { aspectRatio: '16:9', imageSize: '1K' } },
    });
    const ok = res.candidates?.[0]?.content?.parts?.some((p: any) => p.inlineData);
    console.log(ok ? `✓ Gemini image model "${model}" works` : `✗ Gemini image model "${model}" returned no image`);
  } catch (e: any) {
    console.log(`✗ Gemini image model "${model}" FAILED: ${e?.message || e}`);
  }
}

async function checkElevenLabs(model: string) {
  try {
    // /v1/models needs no special permission and confirms the key + the STT model id.
    const res = await fetch('https://api.elevenlabs.io/v1/models', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    });
    if (!res.ok) {
      console.log(`✗ ElevenLabs API key FAILED (HTTP ${res.status})`);
      return;
    }
    console.log(`✓ ElevenLabs API key works (transcription model: ${model})`);
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

const geminiKey = process.env.GEMINI_API_KEY || '';
if (!geminiKey && !process.env.ELEVENLABS_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error('No API keys set in tools/.env (ELEVENLABS_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY).');
  process.exit(1);
}

if (process.env.ELEVENLABS_API_KEY) await checkElevenLabs(engineModel('scribe-v2'));
else console.log('- ELEVENLABS_API_KEY not set — transcription (npm run add / retranscribe) will not work');
if (geminiKey) await checkImage(new GoogleGenAI({ apiKey: geminiKey }), imageModel());
else console.log('- GEMINI_API_KEY not set — header/storyboard image generation will not work');
if (process.env.OPENAI_API_KEY) await checkOpenAI(engineModel('openai-diarize'));
console.log('\nIf the image model failed, set GEMINI_IMAGE_MODEL in tools/.env to a current model id.');
