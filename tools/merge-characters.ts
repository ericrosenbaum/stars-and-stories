/**
 * merge-characters: apply a reviewed character-merge plan to the archive.
 *
 *   cd tools && npm run merge-characters -- ../content/merge-plans/<plan>.json [--dry-run] [--no-build]
 *
 * A plan combines duplicate registry entries (the same character under
 * different spellings, casings or "X" / "X the Mouse" forms), rewrites the
 * embedded character refs in every story.json, fixes name spellings across
 * titles, summaries, highlight quotes, transcripts and descriptions (plus the
 * denormalized copies in worlds.json, forest.json and storyboard captions),
 * retires the losing reference images to content/characters/_retired/<id>/,
 * and records every absorbed name as an alias on the surviving entity so that
 * `npm run add` matches it next time instead of creating a new duplicate.
 *
 * Story slugs (directory names, URLs) are never renamed. Hand-authored essays
 * (world-dna.md, the dragonet dossier, the linguistics report) are not touched.
 *
 * Plan shape — entity refs may be exact registry names or ids:
 * {
 *   "merges": [
 *     {
 *       "keep": "Hattie the Mouse",           // surviving entity (its id, image and description win)
 *       "absorb": ["Hattie", "Haddy"],         // entities folded into it (optional)
 *       "name": "Hattie the Mouse",            // rename the survivor (optional)
 *       "descriptionFrom": "Haddy",            // take the description from another entity (optional)
 *       "aliases": ["Hatty"],                  // extra aliases beyond the absorbed names (optional)
 *       "embedIn": ["Some_Story_Slug"]         // add the survivor to stories that lost it (optional)
 *     }
 *   ],
 *   "spellings": [
 *     { "from": "Haddy", "to": "Hattie" },                                   // whole word, case-insensitive, case-preserving
 *     { "from": "Goofy", "to": "Goober", "caseSensitive": true },            // exact case only
 *     { "from": "\\b([Mm])[eu]r-?[Gg]irl", "to": "$1ergirl", "regex": true } // raw regex, applied globally, $n groups
 *   ],
 *   "remove": ["Friendly Mooker"]   // entities to drop; must not be embedded in any story
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTENT_CHARACTERS,
  CONTENT_PLACES,
  CONTENT_STORIES_DIR,
  CONTENT_CHARACTER_IMAGES_DIR,
  CONTENT_WORLDS,
  CONTENT_FOREST,
  SITE_MEDIA_CHARACTERS_DIR,
  findCharacterImage,
  ensureDir,
} from './lib/paths.ts';
import { recomputeEntityLinks } from './lib/entities.ts';
import { computeWordCounts } from './lib/wordcount.ts';
import { buildSite } from './build-site.ts';
import { compileRules, makeFixer, type SpellingRule } from './lib/spellings.ts';
import type { CanonicalEntity, EmbeddedEntity, StoryRecord } from './lib/types.ts';

interface MergeSpec {
  keep: string;
  absorb?: string[];
  name?: string;
  descriptionFrom?: string;
  aliases?: string[];
  embedIn?: string[];
}
interface MergePlan {
  merges?: MergeSpec[];
  spellings?: SpellingRule[];
  remove?: string[];
}

const RETIRED_DIR = path.join(CONTENT_CHARACTER_IMAGES_DIR, '_retired');
// Keys whose string values are identifiers, not prose — never spell-fix these.
const SKIP_KEYS = new Set([
  'id',
  'slug',
  'placeIds',
  'characterIds',
  'storyIds',
  'firstAppearanceStoryId',
  'audioHash',
  'audioFilename',
  'sourceFilename',
  'file',
  'image',
  'prompt',
  'category',
  'role',
  'zone',
  'size',
  'speaker',
]);

function fail(msg: string): never {
  console.error(`merge-characters: ${msg}`);
  process.exit(1);
}

interface JsonFile<T> {
  data: T;
  /** Formatting of the original file, so a rewrite doesn't churn the diff. */
  indent: number;
  trailingNewline: boolean;
}

function readJson<T>(file: string): JsonFile<T> {
  const raw = fs.readFileSync(file, 'utf8');
  const m = /\n( +)\S/.exec(raw); // first indented line: 2 for both `[\n  {` registries and `{\n  "id"` records
  return { data: JSON.parse(raw) as T, indent: m ? m[1].length : 2, trailingNewline: raw.endsWith('\n') };
}

function writeJson(file: string, data: unknown, fmt: { indent: number; trailingNewline: boolean }, dryRun: boolean): void {
  if (dryRun) return;
  fs.writeFileSync(file, JSON.stringify(data, null, fmt.indent) + (fmt.trailingNewline ? '\n' : ''));
}

/** Spell-fix every prose string in a JSON tree, skipping identifier keys. */
function fixTree(node: any, fix: (s: string) => string, key?: string): any {
  if (typeof node === 'string') return key && SKIP_KEYS.has(key) ? node : fix(node);
  if (Array.isArray(node)) return node.map((n) => fixTree(n, fix, key));
  if (node && typeof node === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(node)) out[k] = SKIP_KEYS.has(k) ? v : fixTree(v, fix, k);
    return out;
  }
  return node;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noBuild = args.includes('--no-build');
  const planPath = args.find((a) => !a.startsWith('--'));
  if (!planPath) fail('usage: npm run merge-characters -- <plan.json> [--dry-run] [--no-build]');
  const plan: MergePlan = JSON.parse(fs.readFileSync(path.resolve(planPath), 'utf8'));

  // ---- load -----------------------------------------------------------------
  const chars = readJson<CanonicalEntity[]>(CONTENT_CHARACTERS);
  const places = readJson<CanonicalEntity[]>(CONTENT_PLACES);
  let characters = chars.data;
  const storyFiles = fs
    .readdirSync(CONTENT_STORIES_DIR)
    .map((slug) => path.join(CONTENT_STORIES_DIR, slug, 'story.json'))
    .filter((f) => fs.existsSync(f));
  const stories = storyFiles.map((file) => {
    const { data, ...fmt } = readJson<StoryRecord>(file);
    return { file, data, fmt, before: JSON.stringify(data) };
  });
  const bySlug = new Map(stories.map((s) => [s.data.id, s]));
  const before = characters.length;

  const byId = new Map(characters.map((c) => [c.id, c]));
  const byExactName = new Map<string, CanonicalEntity[]>();
  for (const c of characters) {
    const list = byExactName.get(c.name) ?? [];
    list.push(c);
    byExactName.set(c.name, list);
  }
  const resolve = (ref: string): CanonicalEntity => {
    const hit = byId.get(ref);
    if (hit) return hit;
    const named = byExactName.get(ref) ?? [];
    if (named.length === 1) return named[0];
    if (named.length > 1) fail(`"${ref}" names ${named.length} entities — use an id: ${named.map((c) => c.id).join(', ')}`);
    return fail(`no character named or id'd "${ref}"`);
  };

  // ---- validate --------------------------------------------------------------
  const merges = plan.merges ?? [];
  const absorbedIds = new Map<string, string>(); // absorbed id -> keep id
  const keepIds = new Set<string>();
  for (const m of merges) {
    const keep = resolve(m.keep);
    if (absorbedIds.has(keep.id)) fail(`"${keep.name}" is both kept and absorbed`);
    keepIds.add(keep.id);
    for (const ref of m.absorb ?? []) {
      const a = resolve(ref);
      if (a.id === keep.id) fail(`"${a.name}" cannot absorb itself`);
      if (keepIds.has(a.id)) fail(`"${a.name}" is both kept and absorbed`);
      if (absorbedIds.has(a.id)) fail(`"${a.name}" is absorbed twice`);
      absorbedIds.set(a.id, keep.id);
    }
    for (const slug of m.embedIn ?? []) if (!bySlug.has(slug)) fail(`embedIn: no story "${slug}"`);
  }
  const removeIds = (plan.remove ?? []).map((r) => resolve(r).id);
  for (const id of removeIds) {
    if (absorbedIds.has(id) || keepIds.has(id)) fail(`"${byId.get(id)!.name}" is both removed and merged`);
    const used = stories.filter((s) => s.data.characters.some((c) => c.id === id)).map((s) => s.data.id);
    if (used.length) fail(`cannot remove "${byId.get(id)!.name}": still embedded in ${used.join(', ')}`);
  }

  console.log(`${dryRun ? '[dry run] ' : ''}Plan: ${merges.length} merges, ${(plan.spellings ?? []).length} spelling rules, ${removeIds.length} removals`);

  // ---- merges -----------------------------------------------------------------
  const imageMoves: string[] = [];
  const staleWebps: string[] = [];
  for (const m of merges) {
    const keep = resolve(m.keep);
    const absorbed = (m.absorb ?? []).map(resolve);
    const oldName = keep.name;
    if (m.name) keep.name = m.name;
    if (m.descriptionFrom) keep.description = resolve(m.descriptionFrom).description;

    // aliases: previous aliases + absorbed names + explicit aliases, minus the surviving name
    const seen = new Set<string>([keep.name.toLowerCase()]);
    const aliases: string[] = [];
    for (const a of [...(keep.aliases ?? []), oldName, ...absorbed.map((e) => e.name), ...(m.aliases ?? [])]) {
      const k = a.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      aliases.push(a.trim());
    }
    if (aliases.length) keep.aliases = aliases;

    // embedded refs
    let touched = 0;
    for (const s of stories) {
      const ids = new Set(absorbed.map((e) => e.id));
      if (!s.data.characters.some((c) => ids.has(c.id))) continue;
      const out: EmbeddedEntity[] = [];
      const have = new Set<string>();
      for (const c of s.data.characters) {
        const id = ids.has(c.id) ? keep.id : c.id;
        if (have.has(id)) continue;
        have.add(id);
        out.push(id === keep.id ? { id: keep.id, name: keep.name, description: keep.description } : c);
      }
      s.data.characters = out;
      touched++;
    }
    for (const slug of m.embedIn ?? []) {
      const s = bySlug.get(slug)!;
      if (!s.data.characters.some((c) => c.id === keep.id)) {
        s.data.characters.push({ id: keep.id, name: keep.name, description: keep.description });
        touched++;
      }
    }

    // reference images: adopt the first absorbed image if the survivor has none, retire the rest
    for (const a of absorbed) {
      const img = findCharacterImage(a.id);
      if (!img) continue;
      const src = path.join(CONTENT_CHARACTER_IMAGES_DIR, a.id);
      if (!findCharacterImage(keep.id)) {
        const dst = path.join(CONTENT_CHARACTER_IMAGES_DIR, keep.id);
        imageMoves.push(`${a.name} (${a.id}) -> adopted by ${keep.name} (${keep.id})`);
        if (!dryRun) {
          if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true });
          fs.renameSync(src, dst);
        }
      } else {
        imageMoves.push(`${a.name} (${a.id}) -> retired to _retired/${a.id}`);
        if (!dryRun) {
          ensureDir(RETIRED_DIR);
          fs.renameSync(src, path.join(RETIRED_DIR, a.id));
        }
      }
      const webp = path.join(SITE_MEDIA_CHARACTERS_DIR, `${a.id}.webp`);
      if (fs.existsSync(webp)) {
        staleWebps.push(webp);
        if (!dryRun) fs.rmSync(webp);
      }
    }

    const absorbedNames = absorbed.map((e) => `${e.name} (${e.storyIds?.length ?? 0})`).join(', ');
    const rename = m.name && m.name !== oldName ? ` [renamed from "${oldName}"]` : '';
    console.log(`  ${keep.name}${rename} <- ${absorbedNames || '(no absorb)'}${touched ? `  · ${touched} story file(s)` : ''}`);
  }
  const dropped = new Set([...absorbedIds.keys(), ...removeIds]);
  characters = characters.filter((c) => !dropped.has(c.id));
  for (const id of removeIds) console.log(`  removed: ${byId.get(id)!.name} (${id})`);

  // ---- spellings ------------------------------------------------------------------
  let rules: ReturnType<typeof compileRules>;
  try {
    rules = compileRules(plan.spellings ?? []);
  } catch (e: any) {
    fail(e?.message || String(e));
  }
  const fix = makeFixer(rules);
  for (const c of characters) {
    c.name = fix(c.name);
    c.description = fix(c.description);
  }
  for (const p of places.data) {
    p.name = fix(p.name);
    p.description = fix(p.description);
  }
  const canonicalById = new Map(characters.map((c) => [c.id, c]));
  const placeById = new Map(places.data.map((p) => [p.id, p]));
  for (const s of stories) {
    const d = s.data;
    d.title = fix(d.title);
    d.summary = fix(d.summary);
    if (d.highlightQuote?.text) d.highlightQuote.text = fix(d.highlightQuote.text);
    const beforeTranscript = JSON.stringify(d.transcript);
    for (const t of d.transcript) t.text = fix(t.text);
    if (JSON.stringify(d.transcript) !== beforeTranscript) Object.assign(d, computeWordCounts(d.transcript));
    // embedded entities mirror the canonical registries
    d.characters = d.characters.map((c) => {
      const can = canonicalById.get(c.id);
      return can ? { id: can.id, name: can.name, description: can.description } : c;
    });
    d.places = (d.places ?? []).map((p) => {
      const can = placeById.get(p.id);
      return can ? { id: can.id, name: can.name, description: can.description } : { ...p, name: fix(p.name), description: fix(p.description) };
    });
  }

  // denormalized copies of titles/quotes/names in the curated datasets and storyboard captions
  const extraFiles: { file: string; data: any; fmt: { indent: number; trailingNewline: boolean }; before: string }[] = [];
  const storyboards = stories.map((s) => path.join(path.dirname(s.file), 'storyboard', 'storyboard.json'));
  for (const file of [CONTENT_WORLDS, CONTENT_FOREST, ...storyboards]) {
    if (!fs.existsSync(file)) continue;
    const { data, ...fmt } = readJson<any>(file);
    extraFiles.push({ file, data: fixTree(data, fix), fmt, before: JSON.stringify(data) });
  }

  if (rules.length) {
    console.log('Spelling fixes (occurrences replaced):');
    for (const r of rules) console.log(`  ${r.hits.toString().padStart(4)}  ${r.from} -> ${r.to}`);
  }

  // ---- recompute links + write ------------------------------------------------------
  const finalChars = recomputeEntityLinks(characters, stories.map((s) => s.data), 'characters').map((c) => {
    const src = canonicalById.get(c.id)!;
    return src.aliases?.length ? { ...c, aliases: src.aliases } : c;
  });
  const finalPlaces = recomputeEntityLinks(places.data, stories.map((s) => s.data), 'places');

  let storyWrites = 0;
  for (const s of stories) {
    if (JSON.stringify(s.data) === s.before) continue;
    storyWrites++;
    writeJson(s.file, s.data, s.fmt, dryRun);
  }
  writeJson(CONTENT_CHARACTERS, finalChars, chars, dryRun);
  writeJson(CONTENT_PLACES, finalPlaces, places, dryRun);
  let extraWrites = 0;
  for (const e of extraFiles) {
    if (JSON.stringify(e.data) === e.before) continue;
    extraWrites++;
    writeJson(e.file, e.data, e.fmt, dryRun);
  }

  console.log(
    `Characters: ${before} -> ${finalChars.length}. Story files changed: ${storyWrites}. Other files changed: ${extraWrites}` +
      (extraWrites ? ` (${extraFiles.filter((e) => JSON.stringify(e.data) !== e.before).map((e) => path.relative(process.cwd(), e.file)).join(', ')})` : '') +
      '.',
  );
  if (imageMoves.length) {
    console.log('Reference images:');
    for (const m of imageMoves) console.log(`  ${m}`);
    if (staleWebps.length) console.log(`  removed ${staleWebps.length} derived webp(s) from site/public/media/characters`);
  }

  // duplicates left behind (e.g. two places that now spell the same name) are a follow-up, not an error
  for (const [label, list] of [
    ['characters', finalChars],
    ['places', finalPlaces],
  ] as const) {
    const counts = new Map<string, number>();
    for (const e of list) counts.set(e.name.toLowerCase(), (counts.get(e.name.toLowerCase()) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    if (dups.length) console.log(`Note: ${label} with duplicate names after this run: ${dups.join('; ')}`);
  }

  if (dryRun) {
    console.log('[dry run] nothing written.');
    return;
  }
  if (!noBuild) {
    console.log('Rebuilding site bundle...');
    return buildSite();
  }
}

Promise.resolve(main()).catch((e) => fail(e?.stack || e?.message || String(e)));
