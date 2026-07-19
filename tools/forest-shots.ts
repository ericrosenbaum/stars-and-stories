/**
 * forest-shots — deterministic screenshot runs of the forest map, for
 * before/after review and style-direction comparison galleries.
 *
 *   npm run forest-shots -- --label baseline
 *   npm run forest-shots -- --label comps --styles parchment,poster,watercolor
 *
 * Spawns the site dev server, loads site/forest-dev.html (engine only, no app
 * shell), drives the camera via the engine's __setCam test hook, and writes
 * PNGs plus a small index.html compare grid to tools/out/forest-shots/<label>/.
 * Output is gitignored — shots are shared with the user directly, not committed.
 */
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser } from 'playwright';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(TOOLS_DIR, '..', 'site');
const OUT_ROOT = path.join(TOOLS_DIR, 'out', 'forest-shots');
const PORT = 5199;
const BASE = `http://localhost:${PORT}`;

// Camera targets in the map's 1000×1400 canvas space (groundY = 1000).
// full = the reset view; the rest exercise the zoom tiers.
const SHOTS: { name: string; cam: [number, number, number] | null }[] = [
  { name: 'full', cam: null },
  { name: 'mid-meadow', cam: [180, 190, 600] },
  { name: 'close-labels', cam: [200, 500, 320] },
  { name: 'soil-burrows', cam: [200, 830, 600] },
];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

function parseArgs(argv: string[]) {
  const args = { label: 'run', styles: [''] as string[] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') args.label = argv[++i] ?? 'run';
    else if (argv[i] === '--styles') args.styles = (argv[++i] ?? '').split(',').map((s) => s.trim());
  }
  return args;
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/forest-dev.html`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server did not come up on :${PORT}`);
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch {
    // Version-pinned fallback to the preinstalled browser.
    return await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  }
}

async function main() {
  const { label, styles } = parseArgs(process.argv.slice(2));
  const outDir = path.join(OUT_ROOT, label);
  fs.mkdirSync(outDir, { recursive: true });

  const server: ChildProcess = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: SITE_DIR, stdio: 'ignore', detached: false,
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', stop);

  try {
    await waitForServer();
    const browser = await launchBrowser();
    const files: string[] = [];

    for (const style of styles) {
      const styleName = style || 'current';
      const url = `${BASE}/forest-dev.html${style ? `?style=${encodeURIComponent(style)}` : ''}`;

      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        await page.goto(url);
        await page.waitForFunction(() => (window as any).__forestReady === true, undefined, { timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400); // filter/paint settle

        const shots = vp.name === 'desktop' ? SHOTS : SHOTS.slice(0, 1); // mobile: full view only
        for (const shot of shots) {
          if (shot.cam) {
            await page.evaluate(([x, y, w]) => {
              (document.querySelector('.forest-map .woodland') as any).__setCam(x, y, w);
            }, shot.cam);
            await page.waitForTimeout(150);
          }
          const file = `${styleName}_${vp.name}_${shot.name}.png`;
          await page.screenshot({ path: path.join(outDir, file) });
          files.push(file);
          console.log(`  ✓ ${file}`);
        }
        await ctx.close();
      }

      // One reduced-motion sanity shot per style (desktop, full view).
      const rmCtx = await browser.newContext({
        viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce',
      });
      const rmPage = await rmCtx.newPage();
      await rmPage.goto(url);
      await rmPage.waitForFunction(() => (window as any).__forestReady === true, undefined, { timeout: 15_000 });
      await rmPage.waitForTimeout(400);
      const rmFile = `${styleName}_desktop_full_reduced-motion.png`;
      await rmPage.screenshot({ path: path.join(outDir, rmFile) });
      files.push(rmFile);
      console.log(`  ✓ ${rmFile}`);
      await rmCtx.close();
    }

    // Compare grid: rows = shot, columns = style.
    const styleNames = styles.map((s) => s || 'current');
    const shotNames = [...new Set(files.map((f) => f.replace(/^[^_]+_/, '')))];
    const rows = shotNames.map((shot) => {
      const cells = styleNames.map((st) => {
        const f = `${st}_${shot}`;
        return files.includes(f)
          ? `<td><figure><img src="${f}" loading="lazy"><figcaption>${st}</figcaption></figure></td>`
          : '<td></td>';
      }).join('');
      return `<tr><th>${shot.replace(/\.png$/, '')}</th>${cells}</tr>`;
    }).join('\n');
    fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html>
<meta charset="utf-8"><title>forest-shots — ${label}</title>
<style>
  body{font:14px system-ui;margin:20px;background:#faf8f2}
  table{border-collapse:collapse} th{text-align:left;padding:8px;vertical-align:top;white-space:nowrap}
  td{padding:8px;vertical-align:top} img{max-width:${Math.floor(92 / Math.max(styleNames.length, 1))}vw;border:1px solid #ddd;border-radius:6px}
  figcaption{color:#777;margin-top:4px;text-align:center}
</style>
<h1>forest-shots — ${label}</h1>
<table>${rows}</table>
`);
    await browser.close();
    console.log(`\nWrote ${files.length} shots + index.html to ${outDir}`);
  } finally {
    stop();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
