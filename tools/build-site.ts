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
  SITE_DATA_DIR,
  SITE_DATA_STORIES_DIR,
  SITE_MEDIA_DIR,
  SITE_MEDIA_CHARACTERS_DIR,
  findCharacterImage,
  ensureDir,
} from './lib/paths.ts';
import { optimizeAudio, optimizeImage } from './lib/media.ts';
import type { StoryRecord, CanonicalEntity } from './lib/types.ts';

const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '40k';
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || '72');
const WEBP_WIDTH = Number(process.env.WEBP_WIDTH || '1280');
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
  ensureDir(SITE_MEDIA_DIR);

  const index: any[] = [];
  for (const s of stories) {
    const mediaRel = `media/${s.id}`;
    const full = {
      id: s.id,
      title: s.title,
      date: s.date,
      summary: s.summary,
      audio: `${mediaRel}/audio.m4a`,
      headerImage: `${mediaRel}/header.webp`,
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
      headerImage: `${mediaRel}/header.webp`,
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

  const worldDna = fs.existsSync(CONTENT_WORLD_DNA) ? fs.readFileSync(CONTENT_WORLD_DNA, 'utf8') : '';
  fs.writeFileSync(path.join(SITE_DATA_DIR, 'world-dna.md'), worldDna);

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
  });

  console.log(`Wrote stories-index.json (${index.length} stories) + per-story JSON + entities.`);
  console.log(`Audio encoded: ${encodedAudio}, images encoded: ${encodedImg}, character images encoded: ${encodedCharImg} (existing skipped).`);
  console.log(`Media: ${mb(dirSize(SITE_MEDIA_DIR))} | Data: ${mb(dirSize(SITE_DATA_DIR))}`);
}

// Run when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildSite({ force: process.argv.includes('--force') });
}
