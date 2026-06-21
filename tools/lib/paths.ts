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

export const SITE_DIR = path.join(ROOT, 'site');
export const SITE_PUBLIC_DIR = path.join(SITE_DIR, 'public');
export const SITE_DATA_DIR = path.join(SITE_PUBLIC_DIR, 'data');
export const SITE_DATA_STORIES_DIR = path.join(SITE_DATA_DIR, 'stories');
export const SITE_MEDIA_DIR = path.join(SITE_PUBLIC_DIR, 'media');

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

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
