/**
 * Regenerate the header image for a single story:
 *   npx tsx regen-image.ts <story-slug> [options]
 *
 * Options:
 *   --prompt "..."   use this exact prompt instead of generating one with Gemini
 *   --no-webp        only write content/stories/<slug>/source.png (skip the served webp)
 *
 * Prints the prompt it uses and the list of character reference images fed to
 * the image model. Reference images are loaded from content/characters/<id>/
 * for every character embedded in the story (see `npm run import-images`).
 *
 * The story slug is the folder name under content/stories/ (also the id shown
 * in the site URL: #/story/<slug>).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  CONTENT_STORIES_DIR,
  SITE_MEDIA_DIR,
  ensureDir,
} from './lib/paths.ts';
import { optimizeImage } from './lib/media.ts';
import { loadCharacterRefImages } from './lib/refimages.ts';
import { generateImagePrompt, generateImageFromPrompt } from './lib/gemini.ts';
import type { StoryRecord } from './lib/types.ts';

const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || '72');
const WEBP_WIDTH = Number(process.env.WEBP_WIDTH || '1280');

// ---- args ----
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const promptIdx = args.indexOf('--prompt');
const customPrompt = promptIdx >= 0 ? args[promptIdx + 1] : null;
// Exclude flags and the --prompt value so the slug is found regardless of order.
// (guard: when --prompt is absent, promptIdx is -1 and must not match index 0)
const promptValIdx = promptIdx >= 0 ? promptIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== promptValIdx);
const slug = positional[0];

function usage(): never {
  console.error('Usage: npx tsx regen-image.ts <story-slug> [--prompt "..."] [--no-webp]');
  process.exit(1);
}

if (!slug || slug.startsWith('--')) usage();
if (promptIdx >= 0 && !customPrompt) {
  console.error('--prompt requires a value (wrap it in quotes).');
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

// ---- reference images ----
const refImages = loadCharacterRefImages(story.characters);
console.log(`\nReference images (${refImages.length}):`);
if (refImages.length) {
  for (const r of refImages) console.log(`  - ${r.name}  (${path.relative(ROOT, r.path)})`);
} else {
  console.log('  (none — no characters in this story have a reference image)');
}

// ---- prompt ----
let prompt = customPrompt;
if (!prompt) {
  console.log('\nGenerating prompt with Gemini...');
  prompt = await generateImagePrompt(story.summary, story.transcript, refImages);
}
console.log(`\nPrompt:\n${prompt}\n`);

// ---- generate ----
console.log('Generating image with Gemini...');
const dataUrl = await generateImageFromPrompt(prompt, refImages);
if (!dataUrl) {
  console.error('Image model returned nothing. Try again, or pass an explicit --prompt.');
  process.exit(1);
}

const b64 = dataUrl.split(',')[1];
const sourcePng = path.join(storyDir, 'source.png');
fs.writeFileSync(sourcePng, Buffer.from(b64, 'base64'));
console.log(`Saved ${path.relative(ROOT, sourcePng)}`);

if (!flags.has('--no-webp')) {
  // Rebuild just this story's served image (a full `npm run build` skips media
  // that already exists, so we re-encode the one header here directly).
  const outDir = path.join(SITE_MEDIA_DIR, slug);
  ensureDir(outDir);
  const headerWebp = path.join(outDir, 'header.webp');
  await optimizeImage(sourcePng, headerWebp, WEBP_WIDTH, WEBP_QUALITY);
  console.log(`Rebuilt ${path.relative(ROOT, headerWebp)}. Reload the site to see it.`);
}

console.log('Done.');
