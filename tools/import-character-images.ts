/**
 * Import character reference images from the world-inventory export into the
 * canonical dataset:
 *   StarsAndStories_World_Inventory_<date>/characters/<Name>/image.<ext>
 *     ->  content/characters/<characterId>/reference.<ext>
 *
 * Matches each inventory folder to a canonical character by (normalized) name.
 * Does NOT use Gemini. Re-runnable (overwrites existing reference images).
 * Next: `npm run build` to optimize them into the site bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  findInventoryDir,
  CONTENT_CHARACTERS,
  CONTENT_CHARACTER_IMAGES_DIR,
  ensureDir,
} from './lib/paths.ts';
import type { CanonicalEntity } from './lib/types.ts';

const norm = (s: string) => (s || '').toLowerCase().trim();
const IMG_RE = /\.(png|jpe?g|webp)$/i;

const inventoryDir = findInventoryDir();
const invCharsDir = path.join(inventoryDir, 'characters');
if (!fs.existsSync(invCharsDir)) {
  console.error(`No characters/ directory in ${inventoryDir}`);
  process.exit(1);
}

const canonical: CanonicalEntity[] = JSON.parse(fs.readFileSync(CONTENT_CHARACTERS, 'utf8'));
const byName = new Map(canonical.map((c) => [norm(c.name), c]));

let matched = 0;
const unmatched: string[] = [];

for (const folder of fs.readdirSync(invCharsDir)) {
  const full = path.join(invCharsDir, folder);
  if (!fs.statSync(full).isDirectory()) continue;
  const imgFile = fs.readdirSync(full).find((f) => IMG_RE.test(f));
  if (!imgFile) continue;

  const name = folder.replace(/_/g, ' ');
  const entity = byName.get(norm(name));
  if (!entity) {
    unmatched.push(name);
    continue;
  }

  const ext = path.extname(imgFile).toLowerCase() === '.jpeg' ? '.jpg' : path.extname(imgFile).toLowerCase();
  const destDir = path.join(CONTENT_CHARACTER_IMAGES_DIR, entity.id);
  ensureDir(destDir);
  // Drop any stale reference.* so a character never has two refs with different extensions.
  for (const f of fs.readdirSync(destDir)) {
    if (/^reference\./i.test(f)) fs.unlinkSync(path.join(destDir, f));
  }
  fs.copyFileSync(path.join(full, imgFile), path.join(destDir, `reference${ext}`));
  console.log(`  ${name}  ->  content/characters/${entity.id}/reference${ext}`);
  matched++;
}

console.log(`\nImported ${matched} character reference image(s).`);
if (unmatched.length) {
  console.warn(`Unmatched (no canonical character with that name): ${unmatched.join(', ')}`);
}
console.log('Next: `npm run build` to optimize them into site/public/media/characters.');
