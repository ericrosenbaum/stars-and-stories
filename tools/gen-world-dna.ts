/**
 * Regenerate the "Deep Analysis: The World DNA" essay over all stories and
 * write it to content/world-dna.md. Uses Gemini. Run `npm run build` after to
 * publish it to the site.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_STORIES_DIR, CONTENT_CHARACTERS, CONTENT_PLACES, CONTENT_WORLD_DNA } from './lib/paths.ts';
import { extractOverallThemes } from './lib/gemini.ts';

const stories = fs
  .readdirSync(CONTENT_STORIES_DIR)
  .filter((s) => fs.existsSync(path.join(CONTENT_STORIES_DIR, s, 'story.json')))
  .map((s) => JSON.parse(fs.readFileSync(path.join(CONTENT_STORIES_DIR, s, 'story.json'), 'utf8')));

const characters = JSON.parse(fs.readFileSync(CONTENT_CHARACTERS, 'utf8'));
const places = JSON.parse(fs.readFileSync(CONTENT_PLACES, 'utf8'));

// Keep the prompt focused (and the token bill sane): recurring entities only.
const recurringChars = characters
  .filter((c: any) => (c.storyIds?.length || 0) >= 2)
  .sort((a: any, b: any) => (b.storyIds?.length || 0) - (a.storyIds?.length || 0));
const recurringPlaces = places
  .filter((p: any) => (p.storyIds?.length || 0) >= 2)
  .sort((a: any, b: any) => (b.storyIds?.length || 0) - (a.storyIds?.length || 0));

console.log(
  `Generating World DNA over ${stories.length} stories, ${recurringChars.length} recurring characters, ${recurringPlaces.length} recurring places...`,
);

const content = await extractOverallThemes(
  stories.map((s: any) => ({ title: s.title, summary: s.summary, date: s.date })),
  recurringChars.map((c: any) => ({ name: c.name, description: c.description || '' })),
  recurringPlaces.map((p: any) => ({ name: p.name, description: p.description || '' })),
);

fs.writeFileSync(CONTENT_WORLD_DNA, content);
console.log(`Wrote ${CONTENT_WORLD_DNA} (${content.length} chars). Run \`npm run build\` to publish it.`);
