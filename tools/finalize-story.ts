/**
 * Step 3 of adding a story: turn a transcribed draft plus the agent's analysis
 * into a published story.
 *   npx tsx finalize-story.ts <draft-id> [--dry-run] [--no-image] [--no-build]
 *   npx tsx finalize-story.ts --list
 *
 * Reads content/drafts/<id>/{draft.json, analysis.json}, matches the analysis's
 * characters/places against the registries (canonical names and aliases), picks
 * the slug from the title, writes content/stories/<slug>/, updates
 * characters.json / places.json / manifest.json, rebuilds the site bundle, and
 * generates header-image candidates from analysis.headerPrompts (review them
 * with `npm run regen-image -- <slug> --select N`). The draft is deleted.
 *
 * --dry-run validates the analysis and prints what would be created (which
 * entities are new, whether the quote anchors) without writing anything.
 */
import 'dotenv/config';
import { finalizeStory, listDrafts, analysisPath } from './lib/add-pipeline.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const id = args.find((a) => !a.startsWith('--'));

if (flags.has('--list')) {
  const drafts = listDrafts();
  if (!drafts.length) {
    console.log('No drafts. Transcribe a recording first: npm run add -- <audio.m4a>');
  } else {
    for (const d of drafts) {
      console.log(
        `${d.id}  (${d.date.slice(0, 10)}, ${d.lines} lines, Izzy ${d.izzyWordCount}w / Dad ${d.dadWordCount}w` +
          `${d.speakerMapConfidence === 'low' ? ', LOW-confidence speaker mapping' : ''})  ${d.hasAnalysis ? 'analysis.json present' : 'awaiting analysis.json'}`,
      );
      d.nextSteps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
    }
  }
  process.exit(0);
}

if (!id) {
  console.error('Usage: npx tsx finalize-story.ts <draft-id> [--dry-run] [--no-image] [--no-build]   |   --list');
  process.exit(1);
}

try {
  const result = await finalizeStory(id, {
    dryRun: flags.has('--dry-run'),
    generateImage: !flags.has('--no-image'),
    build: !flags.has('--no-build'),
    onProgress: (_stage, message) => console.log(message),
  });
  if (result.dryRun) {
    console.log(`\nSlug: ${result.slug}`);
    console.log(`Quote: ${result.quoteAnchored === null ? 'none' : result.quoteAnchored ? 'anchored' : 'NOT anchored (fix the text)'}`);
    console.log(`Header prompts: ${result.hasHeaderPrompts ? "present" : "MISSING (no candidates will be generated)"}`);
    console.log(`\nLooks right? Run: npm run finalize -- ${id}`);
  } else {
    if (result.candidates) {
      console.log(`\nHeader image pending review — the story is published without one until you pick a candidate.`);
      console.log(`  open "${result.candidates.galleryPath}"`);
      console.log(`  npm run regen-image -- ${result.slug} --select <1|2|3>`);
    }
    console.log(`\nDone. Story: #/story/${result.slug}`);
  }
} catch (e: any) {
  console.error(e?.message || e);
  if (/analysis\.json/.test(e?.message || '')) console.error(`\nAnalysis file: ${analysisPath(id)}`);
  process.exit(1);
}
