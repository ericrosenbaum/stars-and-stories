/**
 * Candidate-based generation of the forest map's Tolkien-style landscape image.
 *
 * Deliberate sibling of candidates.ts (header images), specialized for the one
 * map: instead of overwriting the landscape directly, generate a batch of
 * candidates into content/forest-map/candidates/ (gitignored) plus a
 * gallery.html that shows them beside the layout sketch and the current
 * landscape. content/forest-map/landscape.png is only written when a candidate
 * is explicitly selected via `selectLandscapeCandidate`.
 *
 * The candidates are conditioned on a raster of the hand-owned layout sketch
 * (content/forest-map/sketch.svg), so the painting follows that geometry.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ROOT,
  CONTENT_FOREST_MAP_DIR,
  FOREST_SKETCH_SVG,
  FOREST_LANDSCAPE_PNG,
  SITE_MEDIA_FOREST_DIR,
  ensureDir,
} from './paths.ts';
import { optimizeImage } from './media.ts';
import { generateImageFromPrompt } from './gemini.ts';

// Landscape is encoded larger than a story header (the map is zoomed into).
// build-site.ts must use these same values so its encode matches a --select one.
export const FOREST_WEBP_WIDTH = Number(process.env.FOREST_WEBP_WIDTH || '2048');
export const FOREST_WEBP_QUALITY = Number(process.env.FOREST_WEBP_QUALITY || '78');
const LANDSCAPE_WEBP = () => path.join(SITE_MEDIA_FOREST_DIR, 'landscape.webp');

// Rasterize the sketch to this size and force the target aspect (3:4). The
// viewer stretches the 3:4 landscape back into the 5:7 data canvas with
// preserveAspectRatio="none", so this squash is inverted at render time.
const RASTER_W = 1536, RASTER_H = 2048;

const candidatesDir = () => path.join(CONTENT_FOREST_MAP_DIR, 'candidates');
const candidatesJsonPath = () => path.join(candidatesDir(), 'candidates.json');

// How the model should treat the attached sketch (prepended to the prompt).
const SKETCH_INSTRUCTION =
  'The attached image is a schematic layout map. Treat it as the EXACT geographic ground truth: ' +
  'every region, path, water course, and circled site must appear at the same position, size, and ' +
  'shape in your painting. Colored dots mark named sites; paint only the terrain there, never the dots.';

// How the model should treat a candidate it is asked to revise (--edit).
const EDIT_INSTRUCTION =
  'The attached image is a finished map painting. Reproduce it as faithfully as possible — same ' +
  'composition, geography, positions, palette, and linework everywhere — changing ONLY what the ' +
  'requested edits below describe.';

/** Prompt for revising an existing candidate: the edits plus the standing exclusions. */
export function landscapeEditPrompt(edits: string): string {
  return `Requested edits: ${edits}

Everything else stays exactly as it is. The image must still contain NO text of any kind (no letters,
numbers, labels, borders, or legends), NO buildings or structures, and NO people, animals, or creatures.
Portrait orientation, full-bleed edge to edge, no margin or frame.`;
}

/** The Tolkien-atlas base prompt, with optional user feedback woven in. */
export function landscapePrompt(feedback?: string): string {
  const base = `Paint a hand-drawn fantasy storybook map in the style of a classic Tolkien-esque atlas:
aged parchment ground, fine sepia ink linework, dense hand-drawn hatching and stippling, muted
watercolor washes of moss green, umber, and slate blue, soft vignetted edges.

Landscape features only, in four regions exactly where the schematic places them:
- THE MOUNTAINS across the whole top of the map: a snow-capped range with one tallest, pointiest peak above the
  clouds, a glittering mountain of multi-colored crystal among them, and foothills below that reach down to the coast on the right.
- THE WOODS filling the middle and lower left: rolling deciduous forest of individually drawn clustered
  treetops, with an open green hill, a huge old hollow tree in a small clearing, a sunny meadow at the
  forest edge, and a rocky headland where the woods meet the sea. Faint foot trails thread between the
  trees as gaps where the schematic draws them.
- THE OCEAN, a bay on the right that begins below the mountains (it never reaches the top edge), with gentle hatched waves and a sandy beach where it meets the
  land. Four islands, each recognizable by its shape: a perfectly round island with a small volcano in
  its center, a perfectly square island with neat square fields, an island whose coastline is shaped like
  a strawberry (a real island of land with a sandy beach rim and trees, not a floating fruit), and an
  island whose forest grows in concentric rainbow rings (red on the outermost ring, then orange, yellow,
  green, blue, and purple at the center) with a pink and gold beach.
- THE UNDERGROUND: the bottom portion of the image, below the single grassy ground line, is an
  underground cross-section (cutaway) seen side-on: layered brown soil strata, tree roots reaching down,
  and winding EMPTY tunnels connecting rounded EMPTY burrow chambers exactly where the schematic places
  them, with a honeycomb of many small chambers at the deepest level.

STRICT EXCLUSIONS — the image must contain:
- NO text of any kind: no letters, numbers, labels, runes, compass roses, cartouches, borders, title
  banners, or map legends.
- NO buildings or structures: no castles, towers, houses, bridges, or ruins — even where the schematic
  marks a named site, draw only the natural terrain (a peak, a hill, a clearing, a hollow tree, a cliff).
- NO people, animals, or creatures.

Portrait orientation, full-bleed edge to edge, no margin or frame.`;
  return feedback ? `${base}\n\nAdjustments requested: ${feedback}` : base;
}

async function rasterizeSketch(): Promise<Buffer> {
  if (!fs.existsSync(FOREST_SKETCH_SVG)) {
    throw new Error(
      `No layout sketch at ${path.relative(ROOT, FOREST_SKETCH_SVG)}. Generate one first: npm run forest-sketch`,
    );
  }
  // Strip every <text> (place labels and the red notes) before rasterizing: the
  // model copies visible lettering into the painting, and the prompt already
  // describes what each region holds.
  const svg = fs.readFileSync(FOREST_SKETCH_SVG, 'utf8').replace(/<text\b[\s\S]*?<\/text>/g, '');
  return sharp(Buffer.from(svg), { density: 220 })
    .resize(RASTER_W, RASTER_H, { fit: 'fill' })
    .png()
    .toBuffer();
}

export interface LandscapeItem {
  n: number;
  file: string; // candidate-<n>.png relative to the candidates dir
  prompt: string;
}

/**
 * Generate a fresh batch of landscape candidates from the sketch. Replaces any
 * previous batch. Never touches content/forest-map/landscape.png.
 */
export async function generateLandscapeCandidates(
  opts: { feedback?: string; exactPrompt?: string; imageSize?: string; count?: number; edit?: { n: number; edits: string } } = {},
): Promise<{ dir: string; galleryPath: string; items: LandscapeItem[] }> {
  const count = opts.count ?? 3;
  const imageSize = opts.imageSize ?? '2K';
  const sketchPng = await rasterizeSketch();

  // --edit conditions on a candidate of the current batch instead of the sketch
  // (read before the batch directory is replaced below).
  let conditionImage = { data: sketchPng.toString('base64'), mimeType: 'image/png', instruction: SKETCH_INSTRUCTION };
  let prompt = opts.exactPrompt ?? landscapePrompt(opts.feedback);
  if (opts.edit) {
    const base = path.join(candidatesDir(), `candidate-${opts.edit.n}.png`);
    if (!fs.existsSync(base)) throw new Error(`No candidate ${opts.edit.n} in the current batch to edit.`);
    conditionImage = { data: fs.readFileSync(base).toString('base64'), mimeType: 'image/png', instruction: EDIT_INSTRUCTION };
    prompt = landscapeEditPrompt(opts.edit.edits);
  }
  console.log(`\nPrompt (${imageSize}, 3:4), conditioned on ${opts.edit ? `candidate ${opts.edit.n}` : 'the layout sketch'}:\n${prompt}\n`);
  console.log(`Generating ${count} landscape candidate(s) with Gemini...`);

  const images = await Promise.all(
    Array.from({ length: count }, () =>
      generateImageFromPrompt(prompt, [], 1, [], {
        aspectRatio: '3:4',
        imageSize,
        plainPrompt: true,
        conditionImage,
      }).catch((e) => {
        console.warn(`  candidate failed: ${e?.message || e}`);
        return null;
      }),
    ),
  );
  if (!images.some(Boolean)) {
    throw new Error('The image model returned nothing for any candidate. Try again.');
  }

  const dir = candidatesDir();
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  await sharp(sketchPng).toFile(path.join(dir, 'sketch.png'));

  const items: LandscapeItem[] = [];
  images.forEach((dataUrl) => {
    if (!dataUrl) return;
    const n = items.length + 1;
    const file = `candidate-${n}.png`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    items.push({ n, file, prompt });
  });

  fs.writeFileSync(
    candidatesJsonPath(),
    JSON.stringify(
      { createdAt: new Date().toISOString(), ...(opts.feedback ? { feedback: opts.feedback } : {}), items },
      null,
      2,
    ),
  );

  const galleryPath = path.join(dir, 'gallery.html');
  fs.writeFileSync(galleryPath, galleryHtml(items));

  console.log(`\nSaved ${items.length} candidate(s) to ${path.relative(ROOT, dir)}/`);
  console.log(`Review them:  open "${galleryPath}"`);
  console.log(`Then either:`);
  console.log(`  npm run forest-landscape -- --select <n>       # use candidate n as the map landscape`);
  console.log(`  npm run forest-landscape -- --suggest "..."    # new batch with your feedback`);
  console.log(`  npm run forest-landscape -- --discard          # keep the current landscape`);
  return { dir, galleryPath, items };
}

/**
 * Promote candidate `n` to the map landscape: write content/forest-map/landscape.png,
 * re-encode the served webp, and delete the batch. The only place the landscape
 * is ever replaced.
 */
export async function selectLandscapeCandidate(n: number, opts: { webp?: boolean } = {}): Promise<void> {
  const jsonPath = candidatesJsonPath();
  if (!fs.existsSync(jsonPath)) {
    throw new Error('No candidate batch found. Generate one first: npm run forest-landscape');
  }
  const { items } = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { items: LandscapeItem[] };
  const item = items.find((it) => it.n === n);
  if (!item) throw new Error(`No candidate ${n}. Available: ${items.map((it) => it.n).join(', ')}`);

  ensureDir(CONTENT_FOREST_MAP_DIR);
  fs.copyFileSync(path.join(candidatesDir(), item.file), FOREST_LANDSCAPE_PNG);
  console.log(`Selected candidate ${n} -> ${path.relative(ROOT, FOREST_LANDSCAPE_PNG)}`);

  if (opts.webp !== false) {
    // A full `npm run build` skips media that already exists, so re-encode the
    // served landscape directly here; build then just stamps meta.landscape.
    ensureDir(SITE_MEDIA_FOREST_DIR);
    await optimizeImage(FOREST_LANDSCAPE_PNG, LANDSCAPE_WEBP(), FOREST_WEBP_WIDTH, FOREST_WEBP_QUALITY);
    console.log(`Rebuilt ${path.relative(ROOT, LANDSCAPE_WEBP())}.`);
  }
  discardLandscapeCandidates();
}

/** Delete the candidate batch (keeping the current landscape). Returns false if there was none. */
export function discardLandscapeCandidates(): boolean {
  const dir = candidatesDir();
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function galleryHtml(items: LandscapeItem[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hasCurrent = fs.existsSync(FOREST_LANDSCAPE_PNG);

  const card = (label: string, src: string, body: string, cls = '') => `
    <figure class="card${cls ? ' ' + cls : ''}">
      <figcaption>${label}</figcaption>
      <img src="${src}" alt="${esc(label)}" />
      ${body}
    </figure>`;

  const cards = [
    card('The layout sketch', 'sketch.png', '<p class="note">Candidates should follow this geometry. Hand-edit sketch.svg to change it.</p>', 'sketch'),
    ...(hasCurrent
      ? [card('Current landscape', '../landscape.png', '<p class="note">In use today. Discard the candidates to keep it.</p>', 'current')]
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
<title>Forest map — landscape candidates</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; background: #faf8f4; color: #222; }
  h1 { font-size: 1.4rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
  .card { margin: 0; background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 1rem; }
  .card.sketch { border: 2px dashed #999; }
  .card.current { border: 2px solid #b8860b; background: #fdf6e3; }
  .card img { width: 100%; aspect-ratio: 3/4; object-fit: contain; background: #f0ece4; border-radius: 8px; border: 1px solid #eee; }
  figcaption { font-weight: 700; margin-bottom: .6rem; }
  details { margin-top: .6rem; font-size: .8rem; color: #555; } summary { cursor: pointer; }
  .note { font-size: .82rem; color: #866; margin: .6rem 0 0; }
  footer { margin-top: 2rem; font-size: .85rem; color: #666; }
  code { background: #eee; padding: .1rem .35rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>Forest map — landscape candidates</h1>
<div class="grid">
${cards}
</div>
<footer>
  <p>Pick one: <code>npm run forest-landscape -- --select &lt;n&gt;</code>
  &nbsp;|&nbsp; New batch: <code>npm run forest-landscape -- --suggest "..."</code>
  &nbsp;|&nbsp; Keep current: <code>npm run forest-landscape -- --discard</code></p>
</footer>
</body>
</html>
`;
}
