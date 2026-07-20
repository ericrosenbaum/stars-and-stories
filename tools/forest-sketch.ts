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
  canopy: '#4f7a43',
  surface: '#6c9147',
  water: '#4f89ab',
  landmark: '#a8783f',
  underground: '#8a5f3c',
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
  body?: boolean;
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
  const byId = (id: string) => locs.find((l) => l.id === id);

  // --- frame: broad terrain bands ---
  const frame = [
    `<rect x="0" y="0" width="${CW}" height="${CH}" fill="#ffffff"/>`,
    `<!-- mountain band -->`,
    `<rect x="0" y="0" width="${CW}" height="260" fill="#dce4ee"/>`,
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
    const [sx, sy] = pathStart(p.d);
    const lbl = p.label || p.kind;
    pathEls.push(`<text x="${sx.toFixed(0)}" y="${(sy - 6).toFixed(0)}" fill="#6b5c42" font-size="12">${esc(lbl)}</text>`);
  }

  // --- markers (circle + label; circles are what --sync reads back) ---
  const markerEls: string[] = [];
  for (const l of locs) {
    const r = l.size === 'major' ? 14 : 9;
    const fill = ZONE_FILL[l.zone] || ZONE_FILL.surface;
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
  note(CW / 2, 60, 'snow-capped mountain range — jagged peaks up here, foothills below');
  note(CW / 2, 560, 'rolling deciduous forest fills the woodland floor');
  const dd = byId('deep-dark-forest');
  if (dd) note(dd.x, dd.y, 'dense dark forest thicket');
  const pine = byId('pine-tree');
  if (pine) note(pine.x, pine.y - 30, 'pine / evergreen grove');
  note(CW / 2, GY - 12, 'GROUND LINE — below is a side-on underground soil cross-section');
  note(CW / 2, (GY + CH) / 2, 'winding tunnels linking empty burrow chambers · soil strata · tree roots reaching down');
  // Water bodies get a soft outline + a named hint (linear water is a path, skip).
  const waterEls: string[] = [];
  for (const l of locs) {
    if (l.zone !== 'water' || l.body === false) continue;
    const big = l.size === 'major';
    const rx = big ? 78 : 54, ry = big ? 50 : 36;
    waterEls.push(`<ellipse cx="${l.x}" cy="${l.y}" rx="${rx}" ry="${ry}" fill="#cfe3ef" stroke="#4f89ab" stroke-width="2" opacity="0.85"/>`);
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

  <!-- ===== water bodies (ponds / lake / swamp) ===== -->
  <g id="water">
    ${waterEls.join('\n    ')}
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
