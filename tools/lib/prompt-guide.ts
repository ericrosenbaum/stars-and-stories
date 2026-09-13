/**
 * The house rules for image prompts, in one place. These used to live inside
 * Gemini text prompts; now the Claude Code agent writes the prompts itself, so
 * the tools print these briefs for it (`npm run regen-image -- <slug>` and
 * `npm run storyboard -- <slug>` with no mode flags) and CLAUDE.md repeats them.
 */
import type { StoryRecord } from './types.ts';

export const STYLE_REQUIREMENT =
  'A stylish black and white pen and ink illustration on a white background. Use elegant, clean line work. Render a complete scene, but keep the background relatively simple and uncluttered so the characters remain the clear focus. Avoid overly busy or dense textures.';

export const COPYRIGHT_RULE =
  'Never use copyrighted names or trademarked characters in a prompt. If "Mickey" or "Minnie" appear in the story, describe them as "a cheerful cartoon mouse" / "a friendly animated mouse" instead.';

export const COMPOSITION_RULES = [
  'ONE SCENE PER PROMPT: a single specific moment or interaction that captures the mood of the story.',
  'COMPLETE COMPOSITION: the subjects and their immediate surroundings, with the setting established by a few well-chosen details rather than densely rendered.',
  'CLARITY: a strong central composition; the main characters prominent, the background lighter and simpler so they stand out while still conveying a sense of place.',
  'Each prompt must be fully self-contained (do not refer to other prompts).',
];

/** The reference-image binding rule, for the characters that have a portrait. */
export function referenceRule(refNames: string[]): string {
  if (!refNames.length) return 'No character in this story has a reference image, so describe every character visually.';
  return (
    `These characters have reference images that the image model receives: ${refNames.join(', ')}. ` +
    'For EVERY one of them that appears in a scene, name them and append the exact phrase "(as in the image reference)" ' +
    'immediately after the name, e.g. "Seeker (as in the image reference) stands beside a glowing lantern". Keep their ' +
    'own description to a few words and rely on the reference for their appearance. Never use the phrase for anyone else.'
  );
}

function storyContext(story: StoryRecord, refNames: string[]): string {
  const refSet = new Set(refNames);
  const chars = story.characters.map((c) => `  - ${c.name}${refSet.has(c.name) ? ' [reference image]' : ''}: ${c.description}`);
  return [
    `Story: "${story.title}" (${story.id})`,
    `Summary: ${story.summary}`,
    `Characters:`,
    ...(chars.length ? chars : ['  (none)']),
    `Places: ${story.places.map((p) => p.name).join(', ') || '(none)'}`,
  ].join('\n');
}

/** Everything the agent needs to write header-image prompts for a story. */
export function headerPromptBrief(story: StoryRecord, refNames: string[]): string {
  return [
    storyContext(story, refNames),
    '',
    'Write 3 DISTINCT header prompts — each a different moment from the story, or a clearly different treatment of its most striking moment — as a JSON array of strings, then run:',
    `  npm run regen-image -- ${story.id} --prompts <file.json>`,
    '',
    `Style requirement (state it in every prompt): ${STYLE_REQUIREMENT}`,
    ...COMPOSITION_RULES.map((r) => `- ${r}`),
    `- ${referenceRule(refNames)}`,
    `- ${COPYRIGHT_RULE}`,
    'Read the transcript in content/stories/<slug>/story.json for the moments; the summary alone is too thin.',
  ].join('\n');
}

/** Everything the agent needs to write a storyboard plan for a story. */
export function storyboardPlanBrief(story: StoryRecord, refNames: string[]): string {
  return [
    storyContext(story, refNames),
    `Transcript: ${story.transcript.length} lines, ${story.wordCount} words (read it in content/stories/${story.id}/story.json).`,
    '',
    'Write a plan as JSON — { "scenes": [ { "caption", "quoteSpeaker", "quoteText", "imagePrompt" }, ... ] } — then run:',
    `  npm run storyboard -- ${story.id} --plan <file.json>`,
    '',
    'Planning rules:',
    '- Break the story into an ORDERED sequence of scenes that together tell the WHOLE story from beginning to end; usually 6-12, never more than 16, enough to tell it without padding.',
    "- Include the story's most interesting, funny, or unusual moments.",
    '- caption: ONE sentence, present tense, summarizing the action of the scene.',
    "- quoteSpeaker/quoteText: a short direct quote for that moment copied VERBATIM, character for character, from a single transcript line (prefer Izzy's funny or surprising lines). Never paraphrase, merge lines, or invent dialogue — the tool anchors each quote to its timestamp by exact match.",
    `- imagePrompt: follows the header-prompt rules. Style: ${STYLE_REQUIREMENT}`,
    ...COMPOSITION_RULES.map((r) => `  - ${r}`),
    `  - ${referenceRule(refNames)}`,
    `  - ${COPYRIGHT_RULE}`,
  ].join('\n');
}
