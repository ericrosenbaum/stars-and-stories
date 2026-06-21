// Typed fetch layer for the static data bundle in /public/data.
// All paths resolve against import.meta.env.BASE_URL so the app works both at
// the dev root ("/") and under a GitHub Project Pages base ("/<repo>/").

export interface TranscriptItem {
  speaker: string;
  text: string;
  timestamp: number;
}

export interface HighlightQuote {
  text: string;
  timestamp: number | null;
}

export interface EmbeddedEntity {
  id: string;
  name: string;
  description: string;
}

export interface StoryIndexItem {
  id: string;
  title: string;
  date: string;
  summary: string;
  headerImage: string;
  wordCount: number;
  izzyWordCount: number;
  dadWordCount: number;
  characterIds: string[];
  placeIds: string[];
}

export interface StoryFull {
  id: string;
  title: string;
  date: string;
  summary: string;
  audio: string;
  headerImage: string;
  highlightQuote: HighlightQuote | null;
  transcript: TranscriptItem[];
  characters: EmbeddedEntity[];
  places: EmbeddedEntity[];
}

export interface CanonicalEntity {
  id: string;
  name: string;
  description: string;
  storyIds: string[];
  firstAppearanceStoryId: string | null;
}

const BASE = import.meta.env.BASE_URL; // always ends with '/'

/** URL for a file inside /public/data. */
export const dataUrl = (p: string) => `${BASE}data/${p}`;
/** URL for an asset path stored relative to the site root (e.g. media/...). */
export const assetUrl = (p: string) => `${BASE}${p}`;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json() as Promise<T>;
}

export const getStoriesIndex = () => getJson<StoryIndexItem[]>(dataUrl('stories-index.json'));
export const getStory = (slug: string) => getJson<StoryFull>(dataUrl(`stories/${encodeURIComponent(slug)}.json`));
export const getCharacters = () => getJson<CanonicalEntity[]>(dataUrl('characters.json'));
export const getPlaces = () => getJson<CanonicalEntity[]>(dataUrl('places.json'));

export async function getWorldDna(): Promise<string> {
  const res = await fetch(dataUrl('world-dna.md'));
  return res.ok ? res.text() : '';
}
