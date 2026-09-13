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
  /** How the current transcript was produced (absent on legacy imports). */
  transcription?: TranscriptionMeta;
}

/** Provenance of a transcript: which engine, with how many keyterms, and how speakers were mapped. */
export interface TranscriptionMeta {
  engine: string;
  model: string;
  keyterms: number;
  at: string; // ISO
  speakerMap?: Record<string, string>;
  speakerMapMethod?: string;
  speakerMapConfidence?: 'high' | 'low';
}

/**
 * A transcribed recording awaiting the agent's analysis, stored in
 * content/drafts/<id>/draft.json next to source.m4a and transcript.txt.
 */
export interface DraftRecord {
  id: string;
  sourceFilename: string;
  audioHash: string;
  date: string; // ISO
  createdAt: string; // ISO
  durationSec: number | null;
  transcript: TranscriptItem[];
  transcription: TranscriptionMeta;
  spellingFixes: Record<string, number>;
  wordCount: number;
  izzyWordCount: number;
  dadWordCount: number;
}

/** What the agent writes to content/drafts/<id>/analysis.json after reading the transcript. */
export interface StoryAnalysis {
  title: string;
  summary: string;
  characters: { name: string; description: string }[];
  places: { name: string; description: string }[];
  /** Verbatim Izzy line; the timestamp is recovered from the transcript when omitted. */
  highlightQuote: { text: string; timestamp?: number | null } | null;
  /** Set when the Dad/Izzy speaker mapping in the draft is backwards. */
  swapSpeakers?: boolean;
  /** Three header-image prompts (house style); omitted = no candidates generated at finalize. */
  headerPrompts?: string[];
}

/** Canonical entity stored in content/characters.json / places.json */
export interface CanonicalEntity {
  id: string;
  name: string;
  description: string;
  storyIds: string[]; // slugs, recomputed
  firstAppearanceStoryId: string | null; // slug of earliest-dated appearance
  /** Other names this entity has gone by (absorbed duplicates); matched by npm run add. */
  aliases?: string[];
}

export interface ManifestEntry {
  audioHash: string;
  sourceFilename: string;
  date: string;
}
