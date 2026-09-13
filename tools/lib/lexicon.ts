import fs from 'node:fs';
import { CONTENT_CHARACTERS, CONTENT_PLACES } from './paths.ts';
import type { CanonicalEntity } from './types.ts';

/** ElevenLabs Scribe's documented limits for the `keyterms` parameter. */
export const KEYTERM_API_MAX_COUNT = 1000;
export const KEYTERM_MAX_CHARS = 49; // "must be less than 50 characters"
export const KEYTERM_MAX_WORDS = 5;
/**
 * How many keyterms we actually send. Measured 2026-09-13 on a two-speaker
 * recording: with 0-250 keyterms Scribe diarizes correctly (Izzy/Dad word
 * split matches the reference); at 300+ it collapses to ONE speaker, and at
 * 1000 the result is nondeterministic (1 or 3 speakers). Who-said-what is the
 * archive's core data, so the list is capped here — by recurrence, which
 * still covers every character and place that appears in 2+ stories (137 +
 * 104 at the time of writing). One-off names fall to content/spellings.json.
 * Override per call with `loadKeyterms({ max })`.
 */
export const KEYTERM_SAFE_COUNT = 250;

export interface Keyterms {
  /** The final list, in priority order (characters first, then places, each by recurrence). */
  terms: string[];
  characters: number;
  places: number;
  /** Names that could not be sent (too long / too many words) or were cut by the cap. */
  dropped: string[];
}

function loadEntities(file: string): CanonicalEntity[] {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    console.warn(`  (could not read ${file} for the keyterm list — transcribing without name hints: ${e?.message || e})`);
    return [];
  }
}

const isSendable = (name: string) =>
  name.length <= KEYTERM_MAX_CHARS && name.trim().split(/\s+/).length <= KEYTERM_MAX_WORDS;

/**
 * The keyterm list for Scribe: canonical character and place names ordered by
 * recurrence (most stories first; characters before places at equal counts),
 * so every recurring name is sent and the cap only ever drops one-offs.
 * Canonical names only — aliases are the misspellings we are steering away
 * from. See KEYTERM_SAFE_COUNT for why the list is not "everything".
 */
export function loadKeyterms(opts: { max?: number } = {}): Keyterms {
  const max = Math.min(opts.max ?? KEYTERM_SAFE_COUNT, KEYTERM_API_MAX_COUNT);
  const tagged: { e: CanonicalEntity; kind: 'character' | 'place' }[] = [
    ...loadEntities(CONTENT_CHARACTERS).filter((e) => e?.name).map((e) => ({ e, kind: 'character' as const })),
    ...loadEntities(CONTENT_PLACES).filter((e) => e?.name).map((e) => ({ e, kind: 'place' as const })),
  ].sort(
    (a, b) =>
      (b.e.storyIds?.length || 0) - (a.e.storyIds?.length || 0) ||
      (a.kind === b.kind ? 0 : a.kind === 'character' ? -1 : 1) ||
      a.e.name.localeCompare(b.e.name),
  );

  const terms: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  let nChars = 0;
  let nPlaces = 0;
  for (const { e, kind } of tagged) {
    const name = e.name.trim().replace(/\s+/g, ' ');
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // same name as an earlier (higher-priority) entity
    if (!isSendable(name) || terms.length >= max) {
      dropped.push(name);
      continue;
    }
    seen.add(key);
    terms.push(name);
    if (kind === 'character') nChars++;
    else nPlaces++;
  }
  return { terms, characters: nChars, places: nPlaces, dropped };
}
