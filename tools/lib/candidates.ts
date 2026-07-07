/**
 * Candidate-based header image generation.
 *
 * Instead of overwriting a story's header image directly, we generate a batch
 * of candidate images into content/stories/<slug>/candidates/ (gitignored),
 * plus a gallery.html for side-by-side review against the current header.
 * The existing source.png / header.webp are only touched when a candidate is
 * explicitly selected via `selectHeaderCandidate`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONTENT_STORIES_DIR, SITE_MEDIA_DIR, ensureDir } from './paths.ts';
import { optimizeImage } from './media.ts';
import { loadCharacterRefImages } from './refimages.ts';
import { generateImagePromptCandidates, generateImageFromPrompt } from './gemini.ts';
import type { StoryRecord } from './types.ts';

const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || '72');
const WEBP_WIDTH = Number(process.env.WEBP_WIDTH || '1280');

export interface CandidateItem {
  n: number;
  file: string; // candidate-<n>.png, relative to the candidates dir
  prompt: string;
}

export interface CandidateSet {
  dir: string;
  galleryPath: string;
  items: CandidateItem[];
}

const candidatesDir = (slug: string) => path.join(CONTENT_STORIES_DIR, slug, 'candidates');
const candidatesJsonPath = (slug: string) => path.join(candidatesDir(slug), 'candidates.json');

/**
 * Generate a fresh batch of header-image candidates for a story. Replaces any
 * previous batch. Never touches the story's existing source.png/header.webp.
 */
export async function generateHeaderCandidates(
  slug: string,
  story: StoryRecord,
  opts: { feedback?: string; exactPrompt?: string; count?: number } = {},
): Promise<CandidateSet> {
  const count = opts.count ?? 3;
  const refImages = loadCharacterRefImages(story.characters);
  console.log(`\nReference images (${refImages.length}):`);
  if (refImages.length) {
    for (const r of refImages) console.log(`  - ${r.name}  (${path.relative(ROOT, r.path)})`);
  } else {
    console.log('  (none — no characters in this story have a reference image)');
  }

  let prompts: string[];
  if (opts.exactPrompt) {
    // The image model is nondeterministic, so the same prompt still yields
    // three different treatments of the requested scene.
    prompts = Array.from({ length: count }, () => opts.exactPrompt!);
    console.log(`\nUsing the provided prompt for all ${count} candidates:\n${opts.exactPrompt}\n`);
  } else {
    console.log(`\nGenerating ${count} prompt candidates with Gemini${opts.feedback ? ' (incorporating your feedback)' : ''}...`);
    prompts = await generateImagePromptCandidates(story.summary, story.transcript, refImages, {
      count,
      feedback: opts.feedback,
    });
    prompts.forEach((p, i) => console.log(`\nPrompt ${i + 1}:\n${p}`));
  }

  console.log(`\nGenerating ${prompts.length} candidate image(s) with Gemini...`);
  const images = await Promise.all(
    prompts.map((p) =>
      generateImageFromPrompt(p, refImages).catch((e) => {
        console.warn(`  candidate failed: ${e?.message || e}`);
        return null;
      }),
    ),
  );
  if (!images.some(Boolean)) {
    throw new Error('The image model returned nothing for any candidate. Try again.');
  }

  const dir = candidatesDir(slug);
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);

  const items: CandidateItem[] = [];
  images.forEach((dataUrl, i) => {
    if (!dataUrl) {
      console.warn(`  candidate ${i + 1}: no image returned, skipped.`);
      return;
    }
    const n = items.length + 1;
    const file = `candidate-${n}.png`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    items.push({ n, file, prompt: prompts[i] });
  });

  fs.writeFileSync(
    candidatesJsonPath(slug),
    JSON.stringify(
      { createdAt: new Date().toISOString(), ...(opts.feedback ? { feedback: opts.feedback } : {}), items },
      null,
      2,
    ),
  );

  const galleryPath = path.join(dir, 'gallery.html');
  fs.writeFileSync(galleryPath, galleryHtml(slug, story, items));

  console.log(`\nSaved ${items.length} candidate(s) to ${path.relative(ROOT, dir)}/`);
  console.log(`Review them:  open "${galleryPath}"`);
  console.log(`Then either:`);
  console.log(`  npm run regen-image -- ${slug} --select <n>        # use candidate n as the header`);
  console.log(`  npm run regen-image -- ${slug} --suggest "..."     # new batch with your feedback`);
  console.log(`  npm run regen-image -- ${slug} --discard           # keep the existing image`);

  return { dir, galleryPath, items };
}

/**
 * Promote candidate `n` to the story's header: overwrite source.png, re-encode
 * the served header.webp, and remove the candidate batch. This is the only
 * place an existing header is ever replaced.
 */
export async function selectHeaderCandidate(
  slug: string,
  n: number,
  opts: { webp?: boolean } = {},
): Promise<void> {
  const jsonPath = candidatesJsonPath(slug);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `No candidate batch found for "${slug}". Generate one first: npm run regen-image -- ${slug}`,
    );
  }
  const { items } = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { items: CandidateItem[] };
  const item = items.find((it) => it.n === n);
  if (!item) {
    throw new Error(`No candidate ${n}. Available: ${items.map((it) => it.n).join(', ')}`);
  }

  const sourcePng = path.join(CONTENT_STORIES_DIR, slug, 'source.png');
  fs.copyFileSync(path.join(candidatesDir(slug), item.file), sourcePng);
  console.log(`Selected candidate ${n} -> ${path.relative(ROOT, sourcePng)}`);
  console.log(`Prompt was:\n${item.prompt}`);

  if (opts.webp !== false) {
    // Rebuild just this story's served image (a full `npm run build` skips
    // media that already exists, so we re-encode the one header directly).
    const outDir = path.join(SITE_MEDIA_DIR, slug);
    ensureDir(outDir);
    const headerWebp = path.join(outDir, 'header.webp');
    await optimizeImage(sourcePng, headerWebp, WEBP_WIDTH, WEBP_QUALITY);
    console.log(`Rebuilt ${path.relative(ROOT, headerWebp)}. Reload the site to see it.`);
  }

  discardHeaderCandidates(slug);
}

/** Delete a story's candidate batch (keeping the existing header). Returns false if there was none. */
export function discardHeaderCandidates(slug: string): boolean {
  const dir = candidatesDir(slug);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function galleryHtml(slug: string, story: StoryRecord, items: CandidateItem[]): string {
  const bust = Date.now();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hasCurrent = fs.existsSync(path.join(CONTENT_STORIES_DIR, slug, 'source.png'));

  const card = (label: string, src: string, body: string, current = false) => `
    <figure class="card${current ? ' current' : ''}">
      <figcaption>${label}</figcaption>
      <img src="${src}?t=${bust}" alt="${esc(label)}" />
      ${body}
    </figure>`;

  const cards = [
    ...(hasCurrent
      ? [card('Current header', '../source.png', '<p class="note">The image in use today. Discard the candidates to keep it.</p>', true)]
      : []),
    ...items.map((it) =>
      card(`Candidate ${it.n}`, it.file, `<details><summary>Prompt</summary><p>${esc(it.prompt)}</p></details>`),
    ),
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Header candidates — ${esc(story.title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; background: #faf8f4; color: #222; }
  h1 { font-size: 1.4rem; } .slug { color: #888; font-weight: normal; font-size: 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
  .card { margin: 0; background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 1rem; }
  .card.current { border: 2px solid #b8860b; background: #fdf6e3; }
  .card img { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 8px; border: 1px solid #eee; }
  figcaption { font-weight: 700; margin-bottom: .6rem; }
  details { margin-top: .6rem; font-size: .85rem; color: #555; } summary { cursor: pointer; }
  .note { font-size: .85rem; color: #866; margin: .6rem 0 0; }
  footer { margin-top: 2rem; font-size: .85rem; color: #666; }
  code { background: #eee; padding: .1rem .35rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>Header candidates — ${esc(story.title)} <span class="slug">(${esc(slug)})</span></h1>
<div class="grid">
${cards}
</div>
<footer>
  <p>Pick one: <code>npm run regen-image -- ${esc(slug)} --select &lt;n&gt;</code>
  &nbsp;|&nbsp; New batch: <code>npm run regen-image -- ${esc(slug)} --suggest "..."</code>
  &nbsp;|&nbsp; Keep current: <code>npm run regen-image -- ${esc(slug)} --discard</code></p>
</footer>
</body>
</html>
`;
}
