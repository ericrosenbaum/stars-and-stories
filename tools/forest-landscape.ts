/**
 * Generate the forest map's Tolkien-style landscape image via candidate batches:
 *   npx tsx forest-landscape.ts [options]
 *
 * Modes (mutually exclusive):
 *   (default)        generate 3 candidate landscapes (conditioned on the layout
 *                    sketch, content/forest-map/sketch.svg) into
 *                    content/forest-map/candidates/ + a gallery.html for review.
 *                    The current landscape is NOT touched.
 *   --prompt "..."   generate the candidates from this exact prompt instead of
 *                    the built-in Tolkien-atlas prompt
 *   --suggest "..."  generate a new batch, weaving this feedback into the prompt
 *   --select N       promote candidate N to content/forest-map/landscape.png +
 *                    the served webp, then delete the batch (the only mode that
 *                    replaces the landscape)
 *   --discard        keep the current landscape; delete the candidate batch
 *
 * Other options:
 *   --size 1K|2K|4K  image resolution (default 2K; env FOREST_IMAGE_SIZE)
 *   --no-webp        with --select: only write landscape.png (skip the webp)
 *   --no-build       with --select: skip refreshing site/public/data afterwards
 *
 * A story needs a slug; the map does not — there is only one landscape.
 */
import 'dotenv/config';
import {
  generateLandscapeCandidates,
  selectLandscapeCandidate,
  discardLandscapeCandidates,
} from './lib/forest-map.ts';
import { buildSite } from './build-site.ts';

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
const customPrompt = flagValue('--prompt');
const suggestion = flagValue('--suggest');
const selectRaw = flagValue('--select');
const sizeRaw = flagValue('--size');

for (const [flag, value] of [
  ['--prompt', customPrompt],
  ['--suggest', suggestion],
  ['--select', selectRaw],
  ['--size', sizeRaw],
] as const) {
  if (flags.has(flag) && (!value || value.startsWith('--'))) {
    console.error(`${flag} requires a value${flag === '--select' || flag === '--size' ? '' : ' (wrap it in quotes)'}.`);
    process.exit(1);
  }
}
const modes = ['--prompt', '--suggest', '--select', '--discard'].filter((f) => flags.has(f));
if (modes.length > 1) {
  console.error(`Choose only one of --prompt / --suggest / --select / --discard (got ${modes.join(' + ')}).`);
  process.exit(1);
}

const imageSize = (sizeRaw ?? process.env.FOREST_IMAGE_SIZE ?? '2K').toUpperCase();
if (!['1K', '2K', '4K'].includes(imageSize)) {
  console.error(`--size expects 1K, 2K, or 4K (got "${imageSize}").`);
  process.exit(1);
}

if (selectRaw !== null) {
  const n = Number(selectRaw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--select expects a candidate number, got "${selectRaw}".`);
    process.exit(1);
  }
  try {
    await selectLandscapeCandidate(n, { webp: !flags.has('--no-webp') });
  } catch (e: any) {
    console.error(e?.message || e);
    process.exit(1);
  }
  if (!flags.has('--no-build')) {
    // meta.landscape is only stamped into the data bundle when landscape.png
    // exists, so selecting the first landscape needs the data refreshed too.
    console.log('Refreshing site data...');
    await buildSite();
  }
} else if (flags.has('--discard')) {
  if (discardLandscapeCandidates()) {
    console.log('Discarded the candidate batch. The current landscape is unchanged.');
  } else {
    console.log('No candidate batch to discard.');
  }
} else {
  await generateLandscapeCandidates({
    exactPrompt: customPrompt ?? undefined,
    feedback: suggestion ?? undefined,
    imageSize,
  });
}

console.log('Done.');
