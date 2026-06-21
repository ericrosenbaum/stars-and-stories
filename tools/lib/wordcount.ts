import type { TranscriptItem } from './types.ts';

export function countWords(text: string): number {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

/**
 * Word counts mirroring the app's logic: Izzy = speaker contains "izzy",
 * Dad = speaker contains "dad" or "eric".
 */
export function computeWordCounts(transcript: TranscriptItem[]) {
  let wordCount = 0;
  let izzyWordCount = 0;
  let dadWordCount = 0;
  for (const item of transcript || []) {
    const n = countWords(item.text);
    wordCount += n;
    const sp = (item.speaker || '').toLowerCase();
    if (sp.includes('izzy')) izzyWordCount += n;
    else if (sp.includes('dad') || sp.includes('eric')) dadWordCount += n;
  }
  return { wordCount, izzyWordCount, dadWordCount };
}
