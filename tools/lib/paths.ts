import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // tools/lib
export const ROOT = path.resolve(here, '..', '..'); // repo root
export const TOOLS_DIR = path.resolve(here, '..');

export const CONTENT_DIR = path.join(ROOT, 'content');
export const CONTENT_STORIES_DIR = path.join(CONTENT_DIR, 'stories');
export const CONTENT_CHARACTERS = path.join(CONTENT_DIR, 'characters.json');
export const CONTENT_PLACES = path.join(CONTENT_DIR, 'places.json');
export const CONTENT_MANIFEST = path.join(CONTENT_DIR, 'manifest.json');
export const CONTENT_WORLD_DNA = path.join(CONTENT_DIR, 'world-dna.md');
// A hand-authored standalone page, copied to site/public and served next to the
// SPA (it is its own document, not a view). See content/dragonet-dossier.md.
export const CONTENT_DRAGONET_DOSSIER = path.join(CONTENT_DIR, 'dragonet-dossier.html');
export const CONTENT_WORLDS = path.join(CONTENT_DIR, 'worlds.json');
export const CONTENT_FOREST = path.join(CONTENT_DIR, 'forest.json');
// Generated forest-map location art lands here as <location-id>.png.
export const CONTENT_FOREST_ART_DIR = path.join(CONTENT_DIR, 'forest-art');
// The image-based forest map: a hand-owned layout sketch (committed) and the
// selected Tolkien-style landscape original (gitignored, like a story source.png).
export const CONTENT_FOREST_MAP_DIR = path.join(CONTENT_DIR, 'forest-map');
export const FOREST_SKETCH_SVG = path.join(CONTENT_FOREST_MAP_DIR, 'sketch.svg');
export const FOREST_LANDSCAPE_PNG = path.join(CONTENT_FOREST_MAP_DIR, 'landscape.png');
// Per-character reference images live at content/characters/<id>/reference.<ext>.
export const CONTENT_CHARACTER_IMAGES_DIR = path.join(CONTENT_DIR, 'characters');
// Transcription-engine comparison runs (gitignored scratch output).
export const CONTENT_BAKEOFF_DIR = path.join(CONTENT_DIR, 'bakeoff');

export const SITE_DIR = path.join(ROOT, 'site');
export const SITE_PUBLIC_DIR = path.join(SITE_DIR, 'public');
export const SITE_DATA_DIR = path.join(SITE_PUBLIC_DIR, 'data');
export const SITE_DATA_STORIES_DIR = path.join(SITE_DATA_DIR, 'stories');
export const SITE_DATA_STORYBOARDS_DIR = path.join(SITE_DATA_DIR, 'storyboards');
export const SITE_MEDIA_DIR = path.join(SITE_PUBLIC_DIR, 'media');
export const SITE_MEDIA_CHARACTERS_DIR = path.join(SITE_MEDIA_DIR, 'characters');
export const SITE_MEDIA_FOREST_DIR = path.join(SITE_MEDIA_DIR, 'forest');

/** Locate the data export directory (StarsAndStories_GitHub_Export_*). */
export function findExportDir(): string {
  const match = fs
    .readdirSync(ROOT)
    .find((e) => e.startsWith('StarsAndStories_GitHub_Export'));
  if (!match) {
    throw new Error(`Could not find an export directory (StarsAndStories_GitHub_Export*) in ${ROOT}`);
  }
  return path.join(ROOT, match);
}

/** Locate the world-inventory export directory (StarsAndStories_World_Inventory_*). */
export function findInventoryDir(): string {
  const match = fs
    .readdirSync(ROOT)
    .find((e) => e.startsWith('StarsAndStories_World_Inventory'));
  if (!match) {
    throw new Error(`Could not find a world-inventory directory (StarsAndStories_World_Inventory*) in ${ROOT}`);
  }
  return path.join(ROOT, match);
}

/**
 * Absolute path to a character's reference image (content/characters/<id>/reference.*),
 * or null if none exists. Path-only — no Gemini/SDK dependency, so build-site can use it.
 */
export function findCharacterImage(id: string): string | null {
  const dir = path.join(CONTENT_CHARACTER_IMAGES_DIR, id);
  if (!fs.existsSync(dir)) return null;
  const file = fs.readdirSync(dir).find((f) => /^reference\.(png|jpe?g|webp)$/i.test(f));
  return file ? path.join(dir, file) : null;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
