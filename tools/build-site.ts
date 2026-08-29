/**
 * Build the static data + media bundle the site consumes:
 *   content/  ->  site/public/data  +  site/public/media
 * Idempotent. Skips media that already exists (use --force to re-encode).
 * Does NOT use Gemini.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTENT_STORIES_DIR,
  CONTENT_CHARACTERS,
  CONTENT_PLACES,
  CONTENT_WORLD_DNA,
  CONTENT_DRAGONET_DOSSIER,
  CONTENT_LINGUISTICS_REPORT,
  CONTENT_WORLDS,
  CONTENT_FOREST,
  CONTENT_FOREST_ART_DIR,
  FOREST_LANDSCAPE_PNG,
  SITE_MEDIA_FOREST_DIR,
  SITE_PUBLIC_DIR,
  SITE_DATA_DIR,
  SITE_DATA_STORIES_DIR,
  SITE_DATA_STORYBOARDS_DIR,
  SITE_MEDIA_DIR,
  SITE_MEDIA_CHARACTERS_DIR,
  findCharacterImage,
  ensureDir,
} from './lib/paths.ts';
import sharp from 'sharp';
import { optimizeAudio, optimizeImage } from './lib/media.ts';
import type { StoryRecord, CanonicalEntity } from './lib/types.ts';

const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '40k';
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || '72');
const WEBP_WIDTH = Number(process.env.WEBP_WIDTH || '1280');
// The forest-map landscape is encoded larger than a story header (it's zoomed
// into). Must match forest-map.ts's FOREST_WEBP_* so a --select encode and a
// build encode are interchangeable.
const FOREST_WEBP_WIDTH = Number(process.env.FOREST_WEBP_WIDTH || '2048');
const FOREST_WEBP_QUALITY = Number(process.env.FOREST_WEBP_QUALITY || '78');
const CHAR_IMG_QUALITY = Number(process.env.CHAR_IMG_QUALITY || '80');
const CHAR_IMG_WIDTH = Number(process.env.CHAR_IMG_WIDTH || '512');

function loadStories(): StoryRecord[] {
  if (!fs.existsSync(CONTENT_STORIES_DIR)) {
    throw new Error(`No content found at ${CONTENT_STORIES_DIR}. Run \`npm run import\` first.`);
  }
  return fs
    .readdirSync(CONTENT_STORIES_DIR)
    .filter((s) => fs.existsSync(path.join(CONTENT_STORIES_DIR, s, 'story.json')))
    .map((s) => JSON.parse(fs.readFileSync(path.join(CONTENT_STORIES_DIR, s, 'story.json'), 'utf8')));
}

interface StoryboardContent {
  createdAt: string;
  scenes: {
    index: number;
    caption: string;
    quote: { speaker: string; text: string; timestamp: number | null };
    prompt: string;
    file: string; // scene-NN.png inside the storyboard dir
  }[];
}

/**
 * Load a story's storyboard (content/stories/<id>/storyboard/storyboard.json)
 * mapped to the shape the site consumes. Scenes whose source PNG is missing
 * (e.g. a frame that failed to generate) are skipped rather than emitted as
 * broken image paths. Returns null when the story has no storyboard.
 */
function loadStoryboard(id: string) {
  const sbDir = path.join(CONTENT_STORIES_DIR, id, 'storyboard');
  const sbJson = path.join(sbDir, 'storyboard.json');
  if (!fs.existsSync(sbJson)) return null;
  const sb: StoryboardContent = JSON.parse(fs.readFileSync(sbJson, 'utf8'));
  const scenes = (sb.scenes || [])
    .filter(
      (sc) =>
        fs.existsSync(path.join(sbDir, sc.file)) ||
        fs.existsSync(path.join(SITE_MEDIA_DIR, id, 'storyboard', sc.file.replace(/\.png$/i, '.webp'))),
    )
    .map((sc) => ({
      index: sc.index,
      image: `media/${id}/storyboard/${sc.file.replace(/\.png$/i, '.webp')}`,
      caption: sc.caption,
      quote: sc.quote,
    }));
  return scenes.length ? scenes : null;
}

async function pmap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function buildSite({ force = false } = {}): Promise<void> {
  const stories = loadStories().sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  ensureDir(SITE_DATA_DIR);
  ensureDir(SITE_DATA_STORIES_DIR);
  ensureDir(SITE_DATA_STORYBOARDS_DIR);
  ensureDir(SITE_MEDIA_DIR);

  const index: any[] = [];
  for (const s of stories) {
    const mediaRel = `media/${s.id}`;
    // A story can legitimately have no header yet (candidates awaiting user
    // selection), so only emit headerImage when the file actually exists.
    const hasHeader =
      fs.existsSync(path.join(CONTENT_STORIES_DIR, s.id, 'source.png')) ||
      fs.existsSync(path.join(SITE_MEDIA_DIR, s.id, 'header.webp'));
    const headerImage = hasHeader ? `${mediaRel}/header.webp` : undefined;
    const storyboard = loadStoryboard(s.id);
    const hasStoryboard = !!storyboard;
    if (storyboard) {
      fs.writeFileSync(
        path.join(SITE_DATA_STORYBOARDS_DIR, `${s.id}.json`),
        JSON.stringify({ id: s.id, title: s.title, date: s.date, scenes: storyboard }),
      );
    }
    const full = {
      id: s.id,
      title: s.title,
      date: s.date,
      summary: s.summary,
      audio: `${mediaRel}/audio.m4a`,
      headerImage,
      hasStoryboard,
      highlightQuote: s.highlightQuote,
      transcript: s.transcript,
      characters: s.characters,
      places: s.places,
    };
    fs.writeFileSync(path.join(SITE_DATA_STORIES_DIR, `${s.id}.json`), JSON.stringify(full));
    index.push({
      id: s.id,
      title: s.title,
      date: s.date,
      summary: s.summary,
      headerImage,
      hasStoryboard,
      wordCount: s.wordCount,
      izzyWordCount: s.izzyWordCount,
      dadWordCount: s.dadWordCount,
      characterIds: s.characters.map((c) => c.id),
      placeIds: s.places.map((p) => p.id),
    });
  }
  fs.writeFileSync(path.join(SITE_DATA_DIR, 'stories-index.json'), JSON.stringify(index));

  // Characters: optimize any reference image into media/characters/<id>.webp and
  // annotate the served record with its `image` path so the site can render it.
  ensureDir(SITE_MEDIA_CHARACTERS_DIR);
  const characters: (CanonicalEntity & { image?: string })[] = JSON.parse(
    fs.readFileSync(CONTENT_CHARACTERS, 'utf8'),
  );
  let encodedCharImg = 0;
  for (const c of characters) {
    const src = findCharacterImage(c.id);
    if (!src) continue;
    const out = path.join(SITE_MEDIA_CHARACTERS_DIR, `${c.id}.webp`);
    if (force || !fs.existsSync(out)) {
      await optimizeImage(src, out, CHAR_IMG_WIDTH, CHAR_IMG_QUALITY);
      encodedCharImg++;
    }
    c.image = `media/characters/${c.id}.webp`;
  }
  fs.writeFileSync(path.join(SITE_DATA_DIR, 'characters.json'), JSON.stringify(characters));
  fs.copyFileSync(CONTENT_PLACES, path.join(SITE_DATA_DIR, 'places.json'));
  // Curated cosmology dataset (optional — omit-if-absent, like a story's header image).
  if (fs.existsSync(CONTENT_WORLDS)) {
    fs.copyFileSync(CONTENT_WORLDS, path.join(SITE_DATA_DIR, 'worlds.json'));
  }
  // Curated forest-map dataset (optional). Unlike worlds.json this is not a
  // straight copy: locations gain an `art` path when a generated illustration
  // exists at content/forest-art/<location-id>.png.
  let encodedForestArt = 0;
  if (fs.existsSync(CONTENT_FOREST)) {
    const forest = JSON.parse(fs.readFileSync(CONTENT_FOREST, 'utf8'));
    for (const loc of forest.locations ?? []) {
      const src = path.join(CONTENT_FOREST_ART_DIR, `${loc.id}.png`);
      if (!fs.existsSync(src)) continue;
      const out = path.join(SITE_MEDIA_FOREST_DIR, `${loc.id}.webp`);
      if (force || !fs.existsSync(out)) {
        ensureDir(SITE_MEDIA_FOREST_DIR);
        await optimizeImage(src, out, WEBP_WIDTH, WEBP_QUALITY);
        encodedForestArt++;
      }
      loc.art = `media/forest/${loc.id}.webp`;
    }
    // The Tolkien-style landscape backdrop (optional — the viewer falls back to
    // the legacy procedural renderer when meta.landscape is absent). Encode the
    // served webp and stamp its pixel dimensions so the SVG overlay can map to it.
    if (fs.existsSync(FOREST_LANDSCAPE_PNG)) {
      const landscapeWebp = path.join(SITE_MEDIA_FOREST_DIR, 'landscape.webp');
      if (force || !fs.existsSync(landscapeWebp)) {
        ensureDir(SITE_MEDIA_FOREST_DIR);
        await optimizeImage(FOREST_LANDSCAPE_PNG, landscapeWebp, FOREST_WEBP_WIDTH, FOREST_WEBP_QUALITY);
      }
      const dim = await sharp(landscapeWebp).metadata();
      forest.meta = forest.meta ?? {};
      forest.meta.landscape = { image: 'media/forest/landscape.webp', width: dim.width, height: dim.height };
    }
    fs.writeFileSync(path.join(SITE_DATA_DIR, 'forest.json'), JSON.stringify(forest));
  }

  const worldDna = fs.existsSync(CONTENT_WORLD_DNA) ? fs.readFileSync(CONTENT_WORLD_DNA, 'utf8') : '';
  fs.writeFileSync(path.join(SITE_DATA_DIR, 'world-dna.md'), worldDna);

  // Standalone pages live beside index.html rather than in data/, because the
  // browser loads them directly instead of the SPA fetching them.
  if (fs.existsSync(CONTENT_DRAGONET_DOSSIER)) {
    fs.copyFileSync(CONTENT_DRAGONET_DOSSIER, path.join(SITE_PUBLIC_DIR, 'dragonet-dossier.html'));
  }
  if (fs.existsSync(CONTENT_LINGUISTICS_REPORT)) {
    fs.copyFileSync(CONTENT_LINGUISTICS_REPORT, path.join(SITE_PUBLIC_DIR, 'linguistics-report.html'));
  }

  let encodedAudio = 0;
  let encodedImg = 0;
  await pmap(stories, 6, async (s) => {
    const srcDir = path.join(CONTENT_STORIES_DIR, s.id);
    const outDir = path.join(SITE_MEDIA_DIR, s.id);
    ensureDir(outDir);

    const srcAudio = path.join(srcDir, 'source.m4a');
    const outAudio = path.join(outDir, 'audio.m4a');
    if (fs.existsSync(srcAudio) && (force || !fs.existsSync(outAudio))) {
      await optimizeAudio(srcAudio, outAudio, AUDIO_BITRATE);
      encodedAudio++;
    }

    const srcImg = path.join(srcDir, 'source.png');
    const outImg = path.join(outDir, 'header.webp');
    if (fs.existsSync(srcImg) && (force || !fs.existsSync(outImg))) {
      await optimizeImage(srcImg, outImg, WEBP_WIDTH, WEBP_QUALITY);
      encodedImg++;
    }

    const sbSrcDir = path.join(srcDir, 'storyboard');
    if (fs.existsSync(sbSrcDir)) {
      const sbOutDir = path.join(outDir, 'storyboard');
      for (const f of fs.readdirSync(sbSrcDir).filter((f) => /^scene-\d+\.png$/i.test(f))) {
        const out = path.join(sbOutDir, f.replace(/\.png$/i, '.webp'));
        if (force || !fs.existsSync(out)) {
          ensureDir(sbOutDir);
          await optimizeImage(path.join(sbSrcDir, f), out, WEBP_WIDTH, WEBP_QUALITY);
          encodedImg++;
        }
      }
    }
  });

  console.log(`Wrote stories-index.json (${index.length} stories) + per-story JSON + entities.`);
  console.log(`Audio encoded: ${encodedAudio}, images encoded: ${encodedImg}, character images encoded: ${encodedCharImg}, forest art encoded: ${encodedForestArt} (existing skipped).`);
  console.log(`Media: ${mb(dirSize(SITE_MEDIA_DIR))} | Data: ${mb(dirSize(SITE_DATA_DIR))}`);
}

// Run when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildSite({ force: process.argv.includes('--force') });
}
