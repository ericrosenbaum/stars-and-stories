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
  /** Absent while a story's header image is still awaiting candidate selection. */
  headerImage?: string;
  hasStoryboard?: boolean;
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
  /** Absent while a story's header image is still awaiting candidate selection. */
  headerImage?: string;
  hasStoryboard?: boolean;
  highlightQuote: HighlightQuote | null;
  transcript: TranscriptItem[];
  characters: EmbeddedEntity[];
  places: EmbeddedEntity[];
}

export interface StoryboardScene {
  index: number;
  image: string; // media/<slug>/storyboard/scene-NN.webp
  caption: string;
  quote: { speaker: string; text: string; timestamp: number | null };
}

export interface Storyboard {
  id: string;
  title: string;
  date: string;
  scenes: StoryboardScene[];
}

export interface CanonicalEntity {
  id: string;
  name: string;
  description: string;
  storyIds: string[];
  firstAppearanceStoryId: string | null;
  /** Path (relative to the site root) of an optimized reference portrait, if any. */
  image?: string;
}

export interface WorldQuote {
  speaker: string;
  text: string;
  slug: string;
  timestamp: number | null;
}
export interface WorldPotion {
  name: string | null;
  rhyme: string | null;
  mechanic: string | null;
}
export interface WorldStoryRef {
  slug: string;
  title: string;
  date: string;
}
export interface World {
  id: string;
  name: string;
  category: string;
  role: 'home' | 'hub' | 'world';
  ring: number;
  storyCount: number;
  earliestDate: string | null;
  prominence: number;
  curatedDescription: string;
  potion: WorldPotion;
  arrivalFrom: string;
  characters: string[];
  quotes: WorldQuote[];
  stories: WorldStoryRef[];
  placeIds: string[];
  signatureStory: string | null;
  /** Path relative to the site root, e.g. media/<slug>/header.webp. */
  image: string | null;
}
export interface WorldsDoc {
  meta: {
    title?: string;
    subtitle?: string;
    storyCount?: number;
    span?: string;
    law?: string;
    note?: string;
  };
  worlds: World[];
}

export interface ForestLocation {
  id: string;
  name: string;
  zone: 'canopy' | 'surface' | 'water' | 'landmark' | 'underground';
  x: number;
  y: number;
  size: 'major' | 'minor';
  /** false = a marker on linear water (river/stream): no pond blob is drawn. */
  body?: boolean;
  placeIds: string[];
  curatedDescription: string;
  quotes: WorldQuote[];
  characters: string[];
  stories: WorldStoryRef[];
  /** Codex hero image (a story header), path relative to the site root. */
  image: string | null;
  /** Small portrait painted into the marker face (a character portrait). */
  vignette: string | null;
  /** Generated location illustration — injected by build-site when
   *  content/forest-art/<id>.png exists; wins over image and vignette. */
  art?: string;
}
export interface ForestPath {
  id: string;
  kind: 'road' | 'trail' | 'river' | 'stream' | 'tunnel';
  d: string;
  label?: string;
  labelOffset?: string;
}
export interface ForestDoc {
  meta: {
    title?: string;
    subtitle?: string;
    note?: string;
    canvas: { width: number; height: number; groundY: number };
  };
  locations: ForestLocation[];
  paths: ForestPath[];
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
export const getStoryboard = (slug: string) => getJson<Storyboard>(dataUrl(`storyboards/${encodeURIComponent(slug)}.json`));
export const getCharacters = () => getJson<CanonicalEntity[]>(dataUrl('characters.json'));
export const getPlaces = () => getJson<CanonicalEntity[]>(dataUrl('places.json'));
export const getWorlds = () => getJson<WorldsDoc>(dataUrl('worlds.json'));
export const getForest = () => getJson<ForestDoc>(dataUrl('forest.json'));

export async function getWorldDna(): Promise<string> {
  const res = await fetch(dataUrl('world-dna.md'));
  return res.ok ? res.text() : '';
}
