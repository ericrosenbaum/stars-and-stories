export interface TranscriptItem {
  speaker: string;
  text: string;
  timestamp: number;
}

export interface EmbeddedEntity {
  id: string;
  name: string;
  description: string;
}

export interface HighlightQuote {
  text: string;
  timestamp: number | null;
}

/** Normalized per-story record stored in content/stories/<slug>/story.json */
export interface StoryRecord {
  id: string; // slug
  title: string;
  date: string; // ISO
  summary: string;
  audioFilename: string; // original source filename (informational)
  highlightQuote: HighlightQuote | null;
  transcript: TranscriptItem[];
  characters: EmbeddedEntity[];
  places: EmbeddedEntity[];
  wordCount: number;
  izzyWordCount: number;
  dadWordCount: number;
}

/** Canonical entity stored in content/characters.json / places.json */
export interface CanonicalEntity {
  id: string;
  name: string;
  description: string;
  storyIds: string[]; // slugs, recomputed
  firstAppearanceStoryId: string | null; // slug of earliest-dated appearance
}

export interface ManifestEntry {
  audioHash: string;
  sourceFilename: string;
  date: string;
}
