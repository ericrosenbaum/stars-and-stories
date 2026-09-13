/**
 * Word-level spelling rules for names, shared by the transcription pipeline
 * (content/spellings.json is applied to every transcript on the way out of
 * the engine) and by merge-characters.ts (a plan's `spellings` section).
 *
 * A rule is `{ from, to }` — a whole word, matched case-insensitively and
 * replaced case-preservingly — or `{ from, to, regex: true }`, a raw regex
 * applied globally with `$n` group references. `caseSensitive: true` matches
 * exact case only (for misspellings that are also ordinary words).
 */
import fs from 'node:fs';
import { CONTENT_SPELLINGS } from './paths.ts';
import type { TranscriptItem } from './types.ts';

export interface SpellingRule {
  from: string;
  to: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface CompiledRule extends SpellingRule {
  rx: RegExp;
  hits: number;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function preserveCase(matched: string, to: string): string {
  if (matched.length > 1 && matched === matched.toUpperCase() && matched !== matched.toLowerCase()) {
    return to.toUpperCase();
  }
  const first = matched[0];
  if (first && first === first.toLowerCase() && first !== first.toUpperCase()) {
    return to[0].toLowerCase() + to.slice(1);
  }
  return to;
}

export function compileRules(rules: SpellingRule[]): CompiledRule[] {
  return rules.map((r) => {
    if (!r.from || typeof r.to !== 'string') throw new Error(`bad spelling rule: ${JSON.stringify(r)}`);
    const flags = r.caseSensitive ? 'g' : 'gi';
    const rx = r.regex ? new RegExp(r.from, flags) : new RegExp(`\\b${escapeRegExp(r.from)}\\b`, flags);
    return { ...r, rx, hits: 0 };
  });
}

/** A text -> text function applying the rules in order and counting hits on each rule. */
export function makeFixer(rules: CompiledRule[]): (text: string) => string {
  return (text: string): string => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const r of rules) {
      out = out.replace(r.rx, (...args: any[]) => {
        r.hits++;
        if (r.regex) {
          // Expand $1..$9 group references manually so hits can be counted.
          return r.to.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? '');
        }
        return preserveCase(args[0], r.to);
      });
    }
    return out;
  };
}

/** The archive's curated misspelling list (content/spellings.json), or [] when absent. */
export function loadSpellingRules(file = CONTENT_SPELLINGS): SpellingRule[] {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rules = Array.isArray(data) ? data : data?.rules;
  return Array.isArray(rules) ? rules : [];
}

/**
 * Apply content/spellings.json to a transcript. Returns the corrected lines
 * plus a `{ "from -> to": hits }` tally of the rules that fired, for logging.
 */
export function normalizeTranscriptSpellings(
  transcript: TranscriptItem[],
  rules: SpellingRule[] = loadSpellingRules(),
): { transcript: TranscriptItem[]; fixes: Record<string, number> } {
  const compiled = compileRules(rules);
  const fix = makeFixer(compiled);
  const out = transcript.map((t) => ({ ...t, text: fix(t.text) }));
  const fixes: Record<string, number> = {};
  for (const r of compiled) if (r.hits) fixes[`${r.from} -> ${r.to}`] = r.hits;
  return { transcript: out, fixes };
}
