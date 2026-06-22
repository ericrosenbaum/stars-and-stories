import fs from 'node:fs';
import path from 'node:path';
import { findCharacterImage } from './paths.ts';
import type { RefImage } from './gemini.ts';
import type { EmbeddedEntity } from './types.ts';

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** A reference image plus the on-disk path it was loaded from (for logging). */
export type LoadedRefImage = RefImage & { path: string };

/**
 * Load Gemini reference images for the characters embedded in a story.
 * Only characters that have a content/characters/<id>/reference.* file are
 * included; the rest are skipped silently.
 */
export function loadCharacterRefImages(characters: EmbeddedEntity[]): LoadedRefImage[] {
  const out: LoadedRefImage[] = [];
  const seen = new Set<string>();
  for (const c of characters) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    const file = findCharacterImage(c.id);
    if (!file) continue;
    const ext = path.extname(file).toLowerCase();
    out.push({
      data: fs.readFileSync(file).toString('base64'),
      mimeType: EXT_MIME[ext] || 'image/png',
      type: 'character',
      name: c.name,
      description: c.description,
      path: file,
    });
  }
  return out;
}
