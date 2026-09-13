/**
 * Step 1 of adding a story: transcribe an iOS voice memo (.m4a) into a draft.
 *   npx tsx add-story.ts <path-to.m4a> [--date YYYY-MM-DD]
 *
 * Transcribes with ElevenLabs Scribe (primed with the archive's complete list of
 * character/place names, spellings normalized, speakers mapped to Dad/Izzy) and
 * writes content/drafts/<id>/{source.m4a, draft.json, transcript.txt}.
 *
 * The analysis (title, summary, characters, places, highlight quote, header
 * prompts) is written by the Claude Code agent as content/drafts/<id>/analysis.json;
 * then `npm run finalize -- <id>` turns the draft into content/stories/<slug>/.
 * See CLAUDE.md ("Adding a story") for the analysis schema and rules.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { transcribeDraft, DuplicateAudioError } from './lib/add-pipeline.ts';
import { QuotaExceededError } from './lib/asr.ts';

// ---- args ----
const args = process.argv.slice(2);
const dateFlagIdx = args.indexOf('--date');
const dateOverride = dateFlagIdx >= 0 ? args[dateFlagIdx + 1] : null;
const dateValIdx = dateFlagIdx >= 0 ? dateFlagIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== dateValIdx);
const audioPath = positional[0];

if (!audioPath) {
  console.error('Usage: npx tsx add-story.ts <path-to.m4a> [--date YYYY-MM-DD]');
  process.exit(1);
}
if (!fs.existsSync(audioPath)) {
  console.error(`File not found: ${audioPath}`);
  process.exit(1);
}
if (dateFlagIdx >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(dateOverride || '')) {
  console.error('--date expects YYYY-MM-DD');
  process.exit(1);
}

try {
  const result = await transcribeDraft(audioPath, {
    date: dateOverride ?? undefined,
    onProgress: (stage, message) => console.log(stage === 'done' ? `\n${message}` : message),
  });
  console.log('\nNext steps:');
  result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
} catch (e: any) {
  if (e instanceof DuplicateAudioError) {
    console.error(`${e.message} Aborting.`);
    process.exit(1);
  }
  if (e instanceof QuotaExceededError) {
    console.error(e.message);
    process.exit(3);
  }
  throw e;
}
