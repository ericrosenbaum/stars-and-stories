import type { TranscriptItem } from './types.ts';

const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The export stores highlightQuote as a bare string, but the UI wants a
 * timestamp for its "play from here" button. Recover one by matching the
 * quote text against the transcript. Returns null when no confident match.
 */
export function recoverQuoteTimestamp(
  quote: string,
  transcript: TranscriptItem[],
): number | null {
  const q = norm(quote);
  if (!q || !transcript?.length) return null;

  // 1. Direct substring match either way.
  for (const item of transcript) {
    const t = norm(item.text);
    if (t && (t.includes(q) || q.includes(t))) {
      return typeof item.timestamp === 'number' ? item.timestamp : null;
    }
  }

  // 2. Best token-overlap fallback (>= 60% of the quote's words present).
  const qTokens = new Set(q.split(' ').filter(Boolean));
  let best: { score: number; ts: number | null } = { score: 0, ts: null };
  for (const item of transcript) {
    const tTokens = norm(item.text).split(' ').filter(Boolean);
    if (!tTokens.length) continue;
    const present = tTokens.filter((tok) => qTokens.has(tok)).length;
    const score = present / Math.max(qTokens.size, 1);
    if (score > best.score) {
      best = { score, ts: typeof item.timestamp === 'number' ? item.timestamp : null };
    }
  }
  return best.score >= 0.6 ? best.ts : null;
}
