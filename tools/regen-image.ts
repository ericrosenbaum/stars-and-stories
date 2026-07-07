/**
 * Manage the header image for a single story via candidate batches:
 *   npx tsx regen-image.ts <story-slug> [options]
 *
 * Modes (mutually exclusive):
 *   (default)        generate 3 candidate images (different scenes/treatments)
 *                    into content/stories/<slug>/candidates/ + a gallery.html
 *                    for review. The existing header is NOT touched.
 *   --prompt "..."   generate the candidates from this exact prompt instead of
 *                    asking Gemini for scene ideas
 *   --suggest "..."  generate a new candidate batch incorporating this feedback
 *   --select N       promote candidate N to source.png + header.webp and
 *                    delete the batch (the only mode that replaces the header)
 *   --discard        keep the existing header; delete the candidate batch
 *
 * Other options:
 *   --no-webp        with --select: only write source.png (skip the served webp)
 *   --no-build       with --select: skip refreshing site/public/data afterwards
 *
 * Prints the prompts it uses and the list of character reference images fed to
 * the image model. Reference images are loaded from content/characters/<id>/
 * for every character embedded in the story (see `npm run import-images`).
 *
 * The story slug is the folder name under content/stories/ (also the id shown
 * in the site URL: #/story/<slug>).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_STORIES_DIR } from './lib/paths.ts';
import {
  generateHeaderCandidates,
  selectHeaderCandidate,
  discardHeaderCandidates,
} from './lib/candidates.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord } from './lib/types.ts';

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
// Valued flags: record each value's index so positionals (the slug) are found
// regardless of argument order.
const valueIdxs = new Set<number>();
function flagValue(name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  valueIdxs.add(idx + 1);
  return args[idx + 1] ?? null;
}
const customPrompt = flagValue('--prompt');
const suggestion = flagValue('--suggest');
const selectRaw = flagValue('--select');
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIdxs.has(i));
const slug = positional[0];

function usage(): never {
  console.error(
    'Usage: npx tsx regen-image.ts <story-slug> [--prompt "..." | --suggest "..." | --select N | --discard] [--no-webp]',
  );
  process.exit(1);
}

if (!slug || slug.startsWith('--')) usage();
for (const [flag, value] of [
  ['--prompt', customPrompt],
  ['--suggest', suggestion],
  ['--select', selectRaw],
] as const) {
  if (flags.has(flag) && (!value || value.startsWith('--'))) {
    console.error(`${flag} requires a value${flag === '--select' ? '' : ' (wrap it in quotes)'}.`);
    process.exit(1);
  }
}
const modes = ['--prompt', '--suggest', '--select', '--discard'].filter((f) => flags.has(f));
if (modes.length > 1) {
  console.error(`Choose only one of --prompt / --suggest / --select / --discard (got ${modes.join(' + ')}).`);
  process.exit(1);
}

const storyDir = path.join(CONTENT_STORIES_DIR, slug);
const storyJsonPath = path.join(storyDir, 'story.json');
if (!fs.existsSync(storyJsonPath)) {
  console.error(`No story found at content/stories/${slug}/story.json`);
  const available = fs.existsSync(CONTENT_STORIES_DIR)
    ? fs.readdirSync(CONTENT_STORIES_DIR).filter((s) => fs.existsSync(path.join(CONTENT_STORIES_DIR, s, 'story.json')))
    : [];
  if (available.length) console.error(`Available slugs:\n  ${available.join('\n  ')}`);
  process.exit(1);
}

const story: StoryRecord = JSON.parse(fs.readFileSync(storyJsonPath, 'utf8'));
console.log(`Story: "${story.title}" (${slug})`);

if (selectRaw !== null) {
  const n = Number(selectRaw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--select expects a candidate number, got "${selectRaw}".`);
    process.exit(1);
  }
  try {
    await selectHeaderCandidate(slug, n, { webp: !flags.has('--no-webp') });
  } catch (e: any) {
    console.error(e?.message || e);
    process.exit(1);
  }
  if (!flags.has('--no-build')) {
    // headerImage is only emitted into the data bundle when a header exists,
    // so a story selecting its FIRST header needs the data refreshed too.
    console.log('Refreshing site data...');
    await buildSite();
  }
} else if (flags.has('--discard')) {
  if (discardHeaderCandidates(slug)) {
    console.log('Discarded the candidate batch. The existing header is unchanged.');
  } else {
    console.log('No candidate batch to discard.');
  }
} else {
  await generateHeaderCandidates(slug, story, {
    exactPrompt: customPrompt ?? undefined,
    feedback: suggestion ?? undefined,
  });
}

console.log('Done.');
