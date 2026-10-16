/**
 * Forest-map layout sketch: the schematic that guides the landscape image model.
 *
 *   npx tsx forest-sketch.ts            generate content/forest-map/sketch.svg
 *                                       from content/forest.json (REFUSES to
 *                                       overwrite an existing sketch)
 *   npx tsx forest-sketch.ts --force    regenerate from scratch, discarding
 *                                       any hand edits
 *   npx tsx forest-sketch.ts --sync     read marker positions / path shapes back
 *                                       out of the (hand-edited) sketch into
 *                                       content/forest.json
 *
 * Workflow: generate the sketch once, then hand-edit sketch.svg (move the
 * `loc--<id>` circles, reshape the `path--<id>` curves, adjust the red notes)
 * until the layout is right. Run `--sync` so forest.json matches, then generate
 * the landscape (`npm run forest-landscape`). The sketch is the source of truth
 * for geometry; forest.json stays the single document the site consumes.
 */
import fs from 'node:fs';
import {
  CONTENT_FOREST,
  CONTENT_FOREST_MAP_DIR,
  FOREST_SKETCH_SVG,
  ROOT,
  ensureDir,
} from './lib/paths.ts';
import path from 'node:path';

// ---- shared geometry / palette (mirrors site/src/forest.js ZONE) ----
const ZONE_FILL: Record<string, string> = {
  woods: '#5b8a43',
  underground: '#8a5f3c',
  ocean: '#3f7fa6',
  mountains: '#7a7f9a',
};
// The ocean: a bay on the right, from below the mountains down to the beach.
const OCEAN_D =
  'M 1000,455 C 900,445 770,455 722,505 C 694,545 700,620 712,690 C 724,790 760,865 820,908 ' +
  'C 870,940 940,958 1000,962 Z';
// The mountain range across the whole top, its foothills reaching the coast on the right.
const MOUNTAINS_D =
  'M 0,0 L 1000,0 L 1000,445 C 900,435 800,425 725,385 C 630,330 520,290 440,300 C 330,320 200,300 0,330 Z';
// Island outlines, keyed by location id: what makes each one recognizable.
const ISLAND_SHAPE: Record<string, (x: number, y: number) => string> = {
  'circular-island': (x, y) => `<circle cx="${x}" cy="${y}" r="62"/>`,
  'square-island': (x, y) => `<rect x="${x - 42}" y="${y - 42}" width="84" height="84"/>`,
  'strawberry-island': (x, y) =>
    `<path d="M ${x},${y + 46} C ${x - 40},${y + 14} ${x - 44},${y - 30} ${x - 18},${y - 36} C ${x - 6},${y - 40} ${x + 6},${y - 40} ${x + 18},${y - 36} C ${x + 44},${y - 30} ${x + 40},${y + 14} ${x},${y + 46} Z"/>`,
  // Concentric rings of forest color, red outermost.
  'rainbow-island': (x, y) =>
    ['#e05a4a', '#ee9a45', '#efd35a', '#7cb95b', '#5b8fd0', '#9a6cc4']
      .map((c, i) => `<ellipse cx="${x}" cy="${y}" rx="${66 - i * 10}" ry="${46 - i * 7}" fill="${c}" stroke="none"/>`)
      .join(''),
};
// Drawing instructions per place (red notes; followed by the model, never drawn).
const PLACE_NOTE: Record<string, string> = {
  'icicles-palace': 'the tallest, pointiest snowy peak, above the clouds',
  'crystal-mountain': 'a mountain of glittering multi-colored crystal (purple, pink, rainbow)',
  'peacocks-tower': 'a great open green hill rising above the treetops',
  'seekers-castle': 'rocky sea cliff, edge of the woods',
  'hatties-workshop': 'a huge old hollow tree in a small clearing, heart of the woods',
  'isabellas-house': 'a sunny open meadow at the edge of the woods',
  'circular-island': 'round island, small volcano in center',
  'square-island': 'square island, square fields',
  'strawberry-island': 'a real island shaped like a strawberry: beach rim, trees',
  'rainbow-island': 'forest in concentric rainbow rings, red outermost',
  'mole-family-tunnel': 'large cozy rounded burrow chamber',
  'uncle-griscos-laboratory': 'large rounded burrow chamber',
  'ant-kingdom': 'deepest level: a big honeycomb of many small ant chambers',
};
// Path stroke by kind: waterways blue, roads/trails tan, tunnels wide + dark.
const PATH_STYLE: Record<string, { stroke: string; width: number; dash?: string }> = {
  road: { stroke: '#b89a63', width: 7 },
  trail: { stroke: '#b89a63', width: 4, dash: '10 8' },
  river: { stroke: '#4f89ab', width: 8 },
  stream: { stroke: '#6fa6c4', width: 5 },
  tunnel: { stroke: '#573a24', width: 14 },
};

interface Loc {
  id: string;
  name: string;
  zone: string;
  x: number;
  y: number;
  size: string;
}
interface Pth {
  id: string;
  kind: string;
  d: string;
  label?: string;
}
interface Forest {
  meta: { canvas: { width: number; height: number; groundY: number } };
  locations: Loc[];
  paths: Pth[];
}

const esc = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** First absolute point of an SVG path's `d` ("M x,y ..." / "M x y ..."). */
function pathStart(d: string): [number, number] {
  const m = d.match(/M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/i);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
}

// ============================ generate ============================
function buildSketch(forest: Forest): string {
  const { width: CW, height: CH, groundY: GY } = forest.meta.canvas;
  const locs = forest.locations;
  const paths = forest.paths;

  // --- frame: the four regions (woods = the white land left over) ---
  const frame = [
    `<rect x="0" y="0" width="${CW}" height="${CH}" fill="#ffffff"/>`,
    `<!-- the mountains -->`,
    `<path d="${MOUNTAINS_D}" fill="#dce4ee"/>`,
    `<!-- the ocean -->`,
    `<path d="${OCEAN_D}" fill="#cfe3ef" stroke="#4f89ab" stroke-width="3"/>`,
    `<!-- underground band (below the ground line) -->`,
    `<rect x="0" y="${GY}" width="${CW}" height="${CH - GY}" fill="#e9dcc4"/>`,
    `<!-- GROUND LINE -->`,
    `<line x1="0" y1="${GY}" x2="${CW}" y2="${GY}" stroke="#5d7a3e" stroke-width="5"/>`,
  ].join('\n    ');

  // --- paths ---
  const pathEls: string[] = [];
  for (const p of paths) {
    const st = PATH_STYLE[p.kind] || PATH_STYLE.trail;
    const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : '';
    pathEls.push(`<path id="path--${esc(p.id)}" d="${esc(p.d)}" stroke="${st.stroke}" stroke-width="${st.width}"${dash}/>`);
    if (p.label) {
      const [sx, sy] = pathStart(p.d);
      pathEls.push(`<text x="${sx.toFixed(0)}" y="${(sy - 6).toFixed(0)}" fill="#6b5c42" font-size="12">${esc(p.label)}</text>`);
    }
  }

  // --- markers (circle + label; circles are what --sync reads back) ---
  const markerEls: string[] = [];
  for (const l of locs) {
    const r = l.size === 'major' ? 14 : 9;
    const fill = ZONE_FILL[l.zone] || ZONE_FILL.woods;
    markerEls.push(
      `<circle id="loc--${esc(l.id)}" cx="${l.x}" cy="${l.y}" r="${r}" fill="${fill}" stroke="#ffffff" stroke-width="2"/>`,
    );
    markerEls.push(
      `<text x="${l.x}" y="${l.y - r - 5}" fill="#2a2418" font-size="12" text-anchor="middle">${esc(l.name)}</text>`,
    );
  }

  // --- notes: drawing instructions for the image model (never rendered) ---
  const notes: string[] = [];
  const note = (x: number, y: number, text: string) =>
    notes.push(`<text x="${x}" y="${y}" text-anchor="middle">${esc(text)}</text>`);
  note(330, 40, 'snow-capped mountain range: jagged peaks, foothills below');
  note(860, 480, 'open ocean, gentle waves');
  note(340, 560, 'rolling deciduous forest fills the woods');
  note(860, 935, 'sandy beach');
  note(CW / 2, GY - 12, 'GROUND LINE: below is a side-on underground soil cross-section');
  note(CW / 2, GY + 40, 'tunnels linking empty burrow chambers · soil strata · tree roots reaching down');
  for (const l of locs) {
    const text = PLACE_NOTE[l.id];
    // Keep notes on the canvas (15px italic ≈ 7px per character).
    if (text) note(Math.max(text.length * 3.6, Math.min(l.x, CW - text.length * 3.6)), l.y + 44, text);
  }
  // Islands: land shapes in the ocean (ocean-zone places only).
  const islandEls: string[] = [];
  for (const l of locs) {
    if (l.zone !== 'ocean') continue;
    const shape = ISLAND_SHAPE[l.id] ?? ((x: number, y: number) => `<ellipse cx="${x}" cy="${y}" rx="55" ry="40"/>`);
    islandEls.push(shape(l.x, l.y));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Forest-map layout sketch. HAND-OWNED after first generation.

  This is the schematic that guides the landscape image model. Edit it freely:
    * move a place: change cx/cy on its circle (id starts with "loc"), and for
      tidiness the x/y of the text beside it
    * reroute a path: edit the d="..." on its path (id starts with "path")
    * retune guidance: edit the red text in the "notes" group; these tell the
      model what terrain belongs where and are NEVER drawn
  Then run the sync command (npm run forest-sketch, sync flag) to write the new
  positions back into content/forest.json.

  Keep edits as plain attribute edits. AVOID wrapping elements in groups with
  transforms: sync tolerates a transform="translate(x,y)" on a loc circle
  itself, but not a transform inherited from a parent group.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CW} ${CH}" width="${CW}" height="${CH}" font-family="Helvetica, Arial, sans-serif">

  <!-- ===== frame: broad terrain regions ===== -->
  <g id="frame">
    ${frame}
  </g>

  <!-- ===== islands in the ocean ===== -->
  <g id="islands" fill="#f1e6c8" stroke="#a8783f" stroke-width="2">
    ${islandEls.join('\n    ')}
  </g>

  <!-- ===== paths: roads, trails, waterways, tunnels ===== -->
  <g id="paths" fill="none" stroke-linecap="round">
    ${pathEls.join('\n    ')}
  </g>

  <!-- ===== markers: one circle per place (positions synced to forest.json) ===== -->
  <g id="markers">
    ${markerEls.join('\n    ')}
  </g>

  <!-- ===== notes: instructions for the image model — followed, never drawn ===== -->
  <g id="notes" fill="#c0392b" font-size="15" font-style="italic">
    ${notes.join('\n    ')}
  </g>
</svg>
`;
}

// ============================== sync ==============================
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}
function translateOf(tag: string): [number, number] {
  const t = attr(tag, 'transform');
  if (!t) return [0, 0];
  const m = t.match(/translate\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\s*\)/);
  return m ? [parseFloat(m[1]), m[2] ? parseFloat(m[2]) : 0] : [0, 0];
}

function syncFromSketch(): void {
  if (!fs.existsSync(FOREST_SKETCH_SVG)) {
    console.error(`No sketch at ${path.relative(ROOT, FOREST_SKETCH_SVG)}. Generate one first: npm run forest-sketch`);
    process.exit(1);
  }
  const svg = fs.readFileSync(FOREST_SKETCH_SVG, 'utf8');
  const forest: Forest = JSON.parse(fs.readFileSync(CONTENT_FOREST, 'utf8'));

  // Parse loc circles and path shapes out of the sketch.
  const sketchLocs = new Map<string, { x: number; y: number }>();
  for (const m of svg.matchAll(/<circle\b[^>]*\bid="loc--([^"]+)"[^>]*>/g)) {
    const tag = m[0];
    const id = m[1];
    const cx = parseFloat(attr(tag, 'cx') || 'NaN');
    const cy = parseFloat(attr(tag, 'cy') || 'NaN');
    if (Number.isNaN(cx) || Number.isNaN(cy)) continue;
    const [tx, ty] = translateOf(tag);
    sketchLocs.set(id, { x: Math.round(cx + tx), y: Math.round(cy + ty) });
  }
  const sketchPaths = new Map<string, string>();
  for (const m of svg.matchAll(/<path\b[^>]*\bid="path--([^"]+)"[^>]*>/g)) {
    const d = attr(m[0], 'd');
    if (d) sketchPaths.set(m[1], d);
  }

  // Apply to forest.json + collect a diff.
  let moved = 0;
  let reshaped = 0;
  const missingFromSketch: string[] = [];
  for (const l of forest.locations) {
    const s = sketchLocs.get(l.id);
    if (!s) {
      missingFromSketch.push(`loc ${l.id}`);
      continue;
    }
    if (s.x !== l.x || s.y !== l.y) {
      console.log(`  ${l.id}: (${l.x},${l.y}) -> (${s.x},${s.y})`);
      l.x = s.x;
      l.y = s.y;
      moved++;
    }
    sketchLocs.delete(l.id);
  }
  for (const p of forest.paths) {
    const d = sketchPaths.get(p.id);
    if (!d) {
      missingFromSketch.push(`path ${p.id}`);
      continue;
    }
    if (d.trim() !== p.d.trim()) {
      console.log(`  path ${p.id}: reshaped`);
      p.d = d.trim();
      reshaped++;
    }
    sketchPaths.delete(p.id);
  }

  fs.writeFileSync(CONTENT_FOREST, JSON.stringify(forest, null, 2) + '\n');
  console.log(`\nSynced ${path.relative(ROOT, CONTENT_FOREST)}: ${moved} marker(s) moved, ${reshaped} path(s) reshaped.`);

  const extraLocs = [...sketchLocs.keys()].map((id) => `loc ${id}`);
  const extraPaths = [...sketchPaths.keys()].map((id) => `path ${id}`);
  if (missingFromSketch.length) {
    console.warn(`\n⚠ In forest.json but NOT in the sketch (left unchanged):\n   ${missingFromSketch.join('\n   ')}`);
  }
  if (extraLocs.length || extraPaths.length) {
    console.warn(`\n⚠ In the sketch but NOT in forest.json (ignored — add them to forest.json to keep):\n   ${[...extraLocs, ...extraPaths].join('\n   ')}`);
  }
}

// ============================== main ==============================
const args = process.argv.slice(2);
const force = args.includes('--force');
const sync = args.includes('--sync');

if (sync) {
  syncFromSketch();
} else {
  if (fs.existsSync(FOREST_SKETCH_SVG) && !force) {
    console.error(
      `${path.relative(ROOT, FOREST_SKETCH_SVG)} already exists and is hand-owned.\n` +
        `Use --force to regenerate it from forest.json (discarding your edits),\n` +
        `or --sync to pull your edited positions back into forest.json.`,
    );
    process.exit(1);
  }
  const forest: Forest = JSON.parse(fs.readFileSync(CONTENT_FOREST, 'utf8'));
  ensureDir(CONTENT_FOREST_MAP_DIR);
  fs.writeFileSync(FOREST_SKETCH_SVG, buildSketch(forest));
  console.log(`Wrote ${path.relative(ROOT, FOREST_SKETCH_SVG)} (${forest.locations.length} places, ${forest.paths.length} paths).`);
  console.log(`Review / hand-edit it, then:`);
  console.log(`  npm run forest-sketch -- --sync        # pull edited positions into forest.json`);
  console.log(`  npm run forest-landscape               # generate the Tolkien-style landscape`);
}
