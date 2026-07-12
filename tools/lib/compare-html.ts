/**
 * Self-contained side-by-side comparison page for bake-off runs (same
 * single-file pattern as the header-candidates gallery). One column per
 * engine; clicking a line seeks the shared audio player, and during playback
 * every column highlights + follows the line at the current time, so an
 * engine with drifting timestamps visibly tracks the wrong line.
 */
import type { EngineId, EngineResult } from './asr.ts';

export interface FailedEngine {
  engine: EngineId;
  error: string;
}

export const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export function compareHtml(
  label: string,
  durationSec: number | null,
  results: EngineResult[],
  failures: FailedEngine[],
  audioFile = 'audio.m4a',
): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // <-escape so transcript text can never terminate the script block.
  const dataJson = JSON.stringify({ results, failures }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Transcription bake-off — ${esc(label)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #faf8f4; color: #222; }
  header { position: sticky; top: 0; z-index: 10; background: #fffdf8; border-bottom: 1px solid #ddd;
           padding: .8rem 1.2rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  header h1 { font-size: 1.05rem; margin: 0; } header .meta { color: #888; font-size: .85rem; }
  header audio { flex: 1 1 320px; min-width: 260px; height: 36px; }
  header label { font-size: .85rem; color: #555; display: inline-flex; align-items: center; gap: .3rem; }
  .grid { display: grid; grid-template-columns: repeat(var(--cols), minmax(320px, 1fr)); gap: 1rem; padding: 1rem 1.2rem; }
  .col { background: #fff; border: 1px solid #ddd; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
  .col .head { padding: .8rem 1rem; border-bottom: 1px solid #eee; background: #fdfbf6; }
  .col .head h2 { margin: 0 0 .3rem; font-size: 1rem; }
  .col .head .stat { font-size: .8rem; color: #666; margin: .1rem 0; }
  .col .head .map { font-size: .8rem; color: #855; margin: .2rem 0 0; }
  .col.failed .head { background: #fdf0ef; }
  .col .err { padding: 1rem; color: #a33; font-size: .85rem; white-space: pre-wrap; }
  .lines { overflow-y: auto; max-height: calc(100vh - 240px); padding: .5rem .6rem 40vh; }
  .line { display: flex; gap: .5rem; padding: .3rem .45rem; border-radius: 8px; cursor: pointer;
          font-size: .88rem; line-height: 1.35; align-items: baseline; }
  .line:hover { background: #f2ede2; }
  .line.izzy { background: #f4ecfb; } .line.izzy:hover { background: #ecdff7; }
  .line.now { outline: 2px solid #b8860b; background: #fdf6e3 !important; }
  .line .ts { color: #999; font-size: .75rem; font-variant-numeric: tabular-nums; flex: 0 0 2.6rem; }
  .line b { flex: 0 0 2.4rem; font-size: .78rem; color: #555; }
  .line.izzy b { color: #7a4ea8; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Bake-off — ${esc(label)}</h1>
    <div class="meta">${durationSec ? fmtTime(durationSec) + ' · ' : ''}click any line to play from there</div>
  </div>
  <audio id="player" controls src="${esc(audioFile)}" preload="metadata"></audio>
  <label>speed <select id="rate"><option>0.75</option><option selected>1</option><option>1.25</option><option>1.5</option></select></label>
  <label><input type="checkbox" id="follow" checked /> follow playback</label>
</header>
<div class="grid" id="grid"></div>
<script>
const DATA = ${dataJson};
const player = document.getElementById('player');
const grid = document.getElementById('grid');
const followBox = document.getElementById('follow');
document.getElementById('rate').addEventListener('change', (e) => { player.playbackRate = Number(e.target.value); });

const cols = DATA.results.length + DATA.failures.length;
grid.style.setProperty('--cols', Math.max(cols, 1));
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmt = (t) => Math.floor(t/60) + ':' + String(Math.floor(t%60)).padStart(2,'0');

const columns = []; // [{lines: [{el, ts}], cur: index|-1}] built once for the highlighter
for (const r of DATA.results) {
  const col = document.createElement('div'); col.className = 'col'; col.dataset.engine = r.engine;
  const cost = r.estimatedCostUsd == null ? 'n/a' : '$' + r.estimatedCostUsd.toFixed(3);
  const mapInfo = r.rawSpeakerMap
    ? '<p class="map">' + esc(Object.entries(r.rawSpeakerMap).map(([k,v]) => k + ' → ' + v).join(', ')) +
      ' <i>(' + esc(r.speakerMapMethod || '?') + '-mapped)</i></p>'
    : '<p class="map">speakers labeled by the model prompt</p>';
  col.innerHTML =
    '<div class="head"><h2>' + esc(r.engine) + '</h2>' +
    '<p class="stat">model: ' + esc(r.model) + '</p>' +
    '<p class="stat">' + r.transcript.length + ' lines · Izzy ' + r.counts.izzyWordCount +
      ' / Dad ' + r.counts.dadWordCount + ' words · ' + (r.elapsedMs/1000).toFixed(1) + 's · est. ' + cost + '</p>' +
    '<p class="stat" title="' + esc(r.costNote) + '">cost basis: ' + esc(r.costNote) + '</p>' +
    mapInfo + '</div>';
  const lines = document.createElement('div'); lines.className = 'lines';
  const entry = { lines: [], cur: -1 };
  r.transcript.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'line ' + (String(item.speaker).toLowerCase().includes('izzy') ? 'izzy' : 'dad');
    div.innerHTML = '<span class="ts">' + fmt(item.timestamp || 0) + '</span><b>' + esc(item.speaker) + '</b><span>' + esc(item.text) + '</span>';
    div.addEventListener('click', () => { player.currentTime = Number(item.timestamp) || 0; player.play().catch(() => {}); });
    lines.appendChild(div);
    entry.lines.push({ el: div, ts: Number(item.timestamp) });
  });
  col.appendChild(lines);
  grid.appendChild(col);
  columns.push(entry);
}
for (const f of DATA.failures) {
  const col = document.createElement('div'); col.className = 'col failed';
  col.innerHTML = '<div class="head"><h2>' + esc(f.engine) + '</h2><p class="stat">failed</p></div>' +
                  '<div class="err">' + esc(f.error) + '</div>';
  grid.appendChild(col);
}

// Highlight (and optionally scroll to) the current line in EVERY column while
// playing — a column whose highlight visibly lags or leads the audio has bad
// timestamps. That comparison is the point. Scans the precomputed timestamp
// arrays (tolerating NaN and out-of-order values) and only touches the DOM
// when a column's current line actually changes.
player.addEventListener('timeupdate', () => {
  const t = player.currentTime + 0.001;
  for (const col of columns) {
    let best = -1, bestTs = -Infinity;
    for (let i = 0; i < col.lines.length; i++) {
      const ts = col.lines[i].ts;
      if (!Number.isNaN(ts) && ts <= t && ts >= bestTs) { best = i; bestTs = ts; }
    }
    if (best === col.cur) continue;
    if (col.cur >= 0) col.lines[col.cur].el.classList.remove('now');
    if (best >= 0) {
      col.lines[best].el.classList.add('now');
      if (followBox.checked && !player.paused) col.lines[best].el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    col.cur = best;
  }
});
</script>
</body>
</html>
`;
}
