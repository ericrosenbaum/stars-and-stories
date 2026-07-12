import fs from 'node:fs';
import { CONTENT_CHARACTERS, CONTENT_PLACES } from './paths.ts';
import type { CanonicalEntity } from './types.ts';

export interface NameLexicon {
  characters: string[];
  places: string[];
}

function loadNames(file: string, max: number): string[] {
  if (!fs.existsSync(file)) return [];
  try {
    const entities: CanonicalEntity[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    return entities
      .filter((e) => e?.name)
      .sort(
        (a, b) =>
          (b.storyIds?.length || 0) - (a.storyIds?.length || 0) || a.name.localeCompare(b.name),
      )
      .slice(0, max)
      .map((e) => e.name);
  } catch (e: any) {
    console.warn(`  (could not read ${file} for the name lexicon — transcribing without spelling hints: ${e?.message || e})`);
    return [];
  }
}

/**
 * Names-only lexicon of the most recurring characters and places, for
 * injection into transcription prompts so familiar names get a consistent
 * spelling. Sorted by how many stories each entity appears in and capped so
 * hundreds of one-off entities don't bloat the prompt (~2-3 KB at defaults).
 * Returns empty lists when the registries are absent, so transcription of
 * audio outside the archive still works.
 */
export function loadNameLexicon(
  opts: { maxCharacters?: number; maxPlaces?: number } = {},
): NameLexicon {
  return {
    characters: loadNames(CONTENT_CHARACTERS, opts.maxCharacters ?? 120),
    places: loadNames(CONTENT_PLACES, opts.maxPlaces ?? 60),
  };
}
