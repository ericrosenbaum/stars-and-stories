/**
 * Manage the header image for a single story via candidate batches:
 *   npx tsx regen-image.ts <story-slug> [mode]
 *
 * Modes (mutually exclusive):
 *   (none)             print the PROMPT BRIEF for this story: summary, characters
 *                      (which have reference images), and the house-style rules
 *                      the Claude Code agent follows to write the prompts
 *   --prompts <file>   generate one candidate per prompt in this JSON file (an
 *                      array of strings, normally 3) into
 *                      content/stories/<slug>/candidates/ + a gallery.html.
 *                      The existing header is NOT touched.
 *   --prompt "..."     generate 3 treatments of this one exact prompt
 *   --reroll           generate a fresh batch from the CURRENT batch's prompts
 *   --select N         promote candidate N to source.png + header.webp and
 *                      delete the batch (the only mode that replaces the header)
 *   --discard          keep the existing header; delete the candidate batch
 *
 * Other options:
 *   --no-webp          with --select: only write source.png (skip the served webp)
 *   --no-build         with --select: skip refreshing site/public/data afterwards
 *
 * Reference images are loaded from content/characters/<id>/ for every character
 * embedded in the story and fed to the image model (see `npm run import-images`).
 * The story slug is the folder name under content/stories/ (also the id shown
 * in the site URL: #/story/<slug>).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_STORIES_DIR } from './lib/paths.ts';
import {
  generateHeaderCandidates,
  rerollHeaderCandidates,
  selectHeaderCandidate,
  discardHeaderCandidates,
} from './lib/candidates.ts';
import { loadCharacterRefImages } from './lib/refimages.ts';
import { headerPromptBrief } from './lib/prompt-guide.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord } from './lib/types.ts';

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const valueIdxs = new Set<number>();
function flagValue(name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  valueIdxs.add(idx + 1);
  return args[idx + 1] ?? null;
}
const promptsFile = flagValue('--prompts');
const customPrompt = flagValue('--prompt');
const selectRaw = flagValue('--select');
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIdxs.has(i));
const slug = positional[0];

function usage(): never {
  console.error(
    'Usage: npx tsx regen-image.ts <story-slug> [--prompts <file.json> | --prompt "..." | --reroll | --select N | --discard] [--no-webp] [--no-build]',
  );
  process.exit(1);
}

if (!slug || slug.startsWith('--')) usage();
for (const [flag, value] of [
  ['--prompts', promptsFile],
  ['--prompt', customPrompt],
  ['--select', selectRaw],
] as const) {
  if (flags.has(flag) && (!value || value.startsWith('--'))) {
    console.error(`${flag} requires a value${flag === '--prompt' ? ' (wrap it in quotes)' : ''}.`);
    process.exit(1);
  }
}
const modes = ['--prompts', '--prompt', '--reroll', '--select', '--discard'].filter((f) => flags.has(f));
if (modes.length > 1) {
  console.error(`Choose only one of ${modes.join(' / ')}.`);
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

function readPrompts(file: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    console.error(`Could not read ${file} as JSON: ${e?.message || e}`);
    process.exit(1);
  }
  const list = Array.isArray(data) ? data : (data as any)?.prompts;
  if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string' && p.trim())) {
    console.error(`${file} must be a JSON array of prompt strings (or { "prompts": [...] }).`);
    process.exit(1);
  }
  return list.map((p: string) => p.trim());
}

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
} else if (flags.has('--reroll')) {
  try {
    await rerollHeaderCandidates(slug, story);
  } catch (e: any) {
    console.error(e?.message || e);
    process.exit(1);
  }
} else if (promptsFile !== null || customPrompt !== null) {
  await generateHeaderCandidates(slug, story, {
    prompts: promptsFile !== null ? readPrompts(promptsFile) : undefined,
    exactPrompt: customPrompt ?? undefined,
  });
} else {
  const refNames = loadCharacterRefImages(story.characters).map((r) => r.name);
  const hasHeader = fs.existsSync(path.join(storyDir, 'source.png'));
  console.log(`Current header: ${hasHeader ? 'yes (a new batch does not replace it until --select)' : 'none'}\n`);
  console.log(headerPromptBrief(story, refNames));
}

console.log('Done.');
