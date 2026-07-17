/**
 * Add a story from an iOS voice memo (.m4a):
 *   npx tsx add-story.ts <path-to.m4a> [options]
 *
 * Options:
 *   --date YYYY-MM-DD     override the story date
 *   --engine <id>        transcription engine (default: scribe-v2; also
 *                        gemini-flash | gemini-pro | openai-diarize)
 *   --no-image           skip header-image candidate generation
 *   --no-build           don't rebuild the site bundle afterwards
 *   --world-dna          also regenerate the World DNA essay
 *   --merge-descriptions use Gemini to merge descriptions of existing entities
 *
 * The pipeline itself lives in lib/add-pipeline.ts (shared with the studio
 * server): dedupe -> transcribe (default: ElevenLabs scribe-v2) -> analyze
 * (Gemini: title/entities/summary/quote) -> merge characters/places -> write
 * content/stories/<slug>/ -> header-image candidates (Gemini) -> rebuild.
 *
 * The story is published WITHOUT a header image at first: three candidate
 * images are generated for review, and the header is finalized afterwards with
 * `npm run regen-image -- <slug> --select <n>`.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { addStory, DuplicateAudioError } from './lib/add-pipeline.ts';
import { ALL_ENGINES, defaultEngine, type EngineId } from './lib/asr.ts';

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dateFlagIdx = args.indexOf('--date');
const dateOverride = dateFlagIdx >= 0 ? args[dateFlagIdx + 1] : null;
const engineFlagIdx = args.indexOf('--engine');
const engine = (engineFlagIdx >= 0 ? args[engineFlagIdx + 1] : defaultEngine()) as EngineId;
// Exclude the --date/--engine values so the audio path is found regardless of order.
const dateValIdx = dateFlagIdx >= 0 ? dateFlagIdx + 1 : -1;
const engineValIdx = engineFlagIdx >= 0 ? engineFlagIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== dateValIdx && i !== engineValIdx);
const audioPath = positional[0];

if (!audioPath) {
  console.error('Usage: npx tsx add-story.ts <path-to.m4a> [--date YYYY-MM-DD] [--engine <id>] [--no-image] [--no-build] [--world-dna] [--merge-descriptions]');
  process.exit(1);
}
if (!fs.existsSync(audioPath)) {
  console.error(`File not found: ${audioPath}`);
  process.exit(1);
}
if (!ALL_ENGINES.includes(engine)) {
  console.error(`Unknown engine "${engine}". Engines: ${ALL_ENGINES.join(', ')}`);
  process.exit(1);
}

let result;
try {
  result = await addStory(audioPath, {
    date: dateOverride ?? undefined,
    engine,
    generateImage: !flags.has('--no-image'),
    build: !flags.has('--no-build'),
    mergeDescriptions: flags.has('--merge-descriptions'),
    onProgress: (stage, message) => {
      if (stage === 'done') return; // the CLI prints its own closing block below
      // Blank line before the milestone messages, matching the original output.
      if (message.startsWith('Added ') || stage === 'candidates') console.log('');
      console.log(message);
    },
  });
} catch (e: any) {
  if (e instanceof DuplicateAudioError) {
    console.error(`${e.message} Aborting.`);
    process.exit(1);
  }
  throw e;
}

if (flags.has('--world-dna')) {
  console.log('Regenerating World DNA...');
  await import('./gen-world-dna.ts');
}

if (result.candidates) {
  console.log(`\nHeader image pending review — the story is published without one until you pick a candidate.`);
  console.log(`  open "${result.candidates.galleryPath}"`);
  console.log(`  npm run regen-image -- ${result.slug} --select <1|2|3>`);
}
console.log('Done.');
