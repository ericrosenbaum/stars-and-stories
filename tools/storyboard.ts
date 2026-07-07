/**
 * Generate a storyboard for a story: an ordered sequence of illustrated scenes
 * that tells the whole story, favoring its interesting/funny/unusual moments.
 *
 *   npx tsx storyboard.ts <story-slug> [options]
 *
 * Modes:
 *   (default)            plan the scenes with Gemini, then generate every frame
 *   --scene N            regenerate just frame N (using its neighbors as
 *                        continuity references); combine with --prompt to
 *                        replace that scene's image prompt first
 *   --plan-only          write/print the scene plan without generating images
 *
 * Options:
 *   --scenes N           ask the planner for exactly N scenes (default: model
 *                        decides, usually 6-12)
 *   --prompt "..."       with --scene N: use this exact prompt for the frame
 *   --no-webp            skip re-encoding the served webp(s)
 *   --no-build           don't rebuild the site data bundle afterwards
 *
 * Files:
 *   content/stories/<slug>/storyboard/storyboard.json   plan + captions/quotes (committed)
 *   content/stories/<slug>/storyboard/scene-NN.png      source frames (gitignored)
 *   site/public/media/<slug>/storyboard/scene-NN.webp   served frames (committed)
 *   site/public/data/storyboards/<slug>.json            emitted by build-site
 *
 * Frames are generated SEQUENTIALLY: each frame receives the character
 * reference images plus up to two preceding frames as continuity references,
 * so recurring elements stay consistent across the sequence.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONTENT_STORIES_DIR, SITE_MEDIA_DIR, ensureDir } from './lib/paths.ts';
import { optimizeImage } from './lib/media.ts';
import { loadCharacterRefImages } from './lib/refimages.ts';
import { recoverQuoteTimestamp } from './lib/quote.ts';
import { generateStoryboardPlan, generateImageFromPrompt, type FrameRef } from './lib/gemini.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord } from './lib/types.ts';

const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || '72');
const WEBP_WIDTH = Number(process.env.WEBP_WIDTH || '1280');

interface StoryboardScene {
  index: number;
  caption: string;
  quote: { speaker: string; text: string; timestamp: number | null };
  prompt: string;
  file: string; // scene-NN.png
}
interface StoryboardContent {
  createdAt: string;
  scenes: StoryboardScene[];
}

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
const scenesRaw = flagValue('--scenes');
const sceneRaw = flagValue('--scene');
const customPrompt = flagValue('--prompt');
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIdxs.has(i));
const slug = positional[0];

function usage(): never {
  console.error(
    'Usage: npx tsx storyboard.ts <story-slug> [--scenes N] [--scene N [--prompt "..."]] [--plan-only] [--no-webp] [--no-build]',
  );
  process.exit(1);
}

if (!slug || slug.startsWith('--')) usage();
const parseCount = (raw: string | null, flag: string): number | null => {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${flag} expects a positive integer, got "${raw}".`);
    process.exit(1);
  }
  return n;
};
const sceneCount = parseCount(scenesRaw, '--scenes');
const sceneToRedo = parseCount(sceneRaw, '--scene');
if (customPrompt !== null && sceneToRedo === null) {
  console.error('--prompt only applies together with --scene N.');
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

const sbDir = path.join(storyDir, 'storyboard');
const sbJsonPath = path.join(sbDir, 'storyboard.json');
const sbMediaDir = path.join(SITE_MEDIA_DIR, slug, 'storyboard');

const refImages = loadCharacterRefImages(story.characters);
console.log(`\nReference images (${refImages.length}):`);
if (refImages.length) {
  for (const r of refImages) console.log(`  - ${r.name}  (${path.relative(ROOT, r.path)})`);
} else {
  console.log('  (none — no characters in this story have a reference image)');
}

function frameRefFromScene(scene: StoryboardScene): FrameRef | null {
  const png = path.join(sbDir, scene.file);
  if (!fs.existsSync(png)) return null;
  return {
    data: fs.readFileSync(png).toString('base64'),
    mimeType: 'image/png',
    label: `frame ${scene.index}: ${scene.caption}`,
  };
}

async function renderScene(scene: StoryboardScene, frameRefs: FrameRef[]): Promise<boolean> {
  const dataUrl = await generateImageFromPrompt(scene.prompt, refImages, 1, frameRefs).catch((e) => {
    console.warn(`  scene ${scene.index} failed: ${e?.message || e}`);
    return null;
  });
  if (!dataUrl) {
    console.warn(`  scene ${scene.index}: no image returned. Redo it later with: npm run storyboard -- ${slug} --scene ${scene.index}`);
    return false;
  }
  const png = path.join(sbDir, scene.file);
  fs.writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`  saved ${path.relative(ROOT, png)}`);
  if (!flags.has('--no-webp')) {
    // A full `npm run build` skips media that already exists, so encode the
    // served webp for this frame directly.
    ensureDir(sbMediaDir);
    await optimizeImage(png, path.join(sbMediaDir, scene.file.replace(/\.png$/i, '.webp')), WEBP_WIDTH, WEBP_QUALITY);
  }
  return true;
}

if (sceneToRedo !== null) {
  // ---- regenerate a single frame ----
  if (!fs.existsSync(sbJsonPath)) {
    console.error(`No storyboard found for "${slug}". Generate one first: npm run storyboard -- ${slug}`);
    process.exit(1);
  }
  const sb: StoryboardContent = JSON.parse(fs.readFileSync(sbJsonPath, 'utf8'));
  const scene = sb.scenes.find((s) => s.index === sceneToRedo);
  if (!scene) {
    console.error(`No scene ${sceneToRedo}. Available: 1-${sb.scenes.length}`);
    process.exit(1);
  }
  if (customPrompt) {
    scene.prompt = customPrompt;
    fs.writeFileSync(sbJsonPath, JSON.stringify(sb, null, 2));
    console.log('Updated the scene prompt in storyboard.json.');
  }
  const neighbors = sb.scenes
    .filter((s) => s.index === sceneToRedo - 1 || s.index === sceneToRedo + 1)
    .map(frameRefFromScene)
    .filter((f): f is FrameRef => !!f);
  console.log(`\nRegenerating scene ${scene.index}/${sb.scenes.length} ("${scene.caption}") with ${neighbors.length} neighboring frame(s) as reference...`);
  console.log(`Prompt:\n${scene.prompt}\n`);
  const ok = await renderScene(scene, neighbors);
  if (ok && !flags.has('--no-build')) {
    console.log('Rebuilding site data...');
    await buildSite();
  }
} else {
  // ---- plan (and generate) the whole storyboard ----
  console.log(`\nPlanning the storyboard with Gemini${sceneCount ? ` (${sceneCount} scenes)` : ''}...`);
  const plan = await generateStoryboardPlan(story.summary, story.transcript, refImages, sceneCount ?? undefined);

  const scenes: StoryboardScene[] = plan.map((p, i) => {
    const timestamp = recoverQuoteTimestamp(p.quoteText, story.transcript);
    if (timestamp === null) {
      console.warn(`  (scene ${i + 1}: quote not found verbatim in the transcript: "${p.quoteText}")`);
    }
    return {
      index: i + 1,
      caption: p.caption,
      quote: { speaker: p.quoteSpeaker, text: p.quoteText, timestamp },
      prompt: p.imagePrompt,
      file: `scene-${String(i + 1).padStart(2, '0')}.png`,
    };
  });

  console.log(`\nPlanned ${scenes.length} scenes:`);
  for (const s of scenes) {
    console.log(`  ${s.index}. ${s.caption}`);
    console.log(`     ${s.quote.speaker}: "${s.quote.text}"`);
  }

  // Replace any previous storyboard wholesale (scene counts may differ, and
  // stale frames must not linger). The plan is written before any image is
  // generated, so an interrupted run can be repaired scene-by-scene.
  fs.rmSync(sbDir, { recursive: true, force: true });
  fs.rmSync(sbMediaDir, { recursive: true, force: true });
  ensureDir(sbDir);
  fs.writeFileSync(sbJsonPath, JSON.stringify({ createdAt: new Date().toISOString(), scenes }, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, sbJsonPath)}`);

  if (flags.has('--plan-only')) {
    console.log('Plan only — no images generated. Generate them by re-running without --plan-only.');
  } else {
    console.log(`\nGenerating ${scenes.length} frames sequentially (each uses preceding frames as references)...`);
    const doneFrames: { scene: StoryboardScene; ref: FrameRef }[] = [];
    let failed = 0;
    for (const scene of scenes) {
      // Up to the 2 most recent successful frames, for visual continuity.
      const frameRefs = doneFrames.slice(-2).map((d) => d.ref);
      console.log(`\nScene ${scene.index}/${scenes.length}: ${scene.caption}`);
      const ok = await renderScene(scene, frameRefs);
      if (ok) {
        const ref = frameRefFromScene(scene);
        if (ref) doneFrames.push({ scene, ref });
      } else {
        failed++;
      }
    }
    if (failed) console.warn(`\n${failed} frame(s) failed — redo each with: npm run storyboard -- ${slug} --scene <n>`);
    if (!flags.has('--no-build')) {
      console.log('\nRebuilding site data...');
      await buildSite();
    }
    console.log(`\nStoryboard ready: #/story/${slug}/storyboard`);
  }
}

console.log('Done.');
