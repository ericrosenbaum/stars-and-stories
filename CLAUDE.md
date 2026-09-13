# Stars & Stories — Claude workflows

A family story archive: `content/` is the canonical data, `tools/` holds Node/tsx
CLIs (run them from `tools/`), `site/` is a Vite + React SPA served from the
committed `site/public/{data,media}` bundle built by `npm run build`. See
README.md for the full tool reference.

## Header images: candidate review is user-driven

Header images are NEVER written directly — every generation produces 3
candidates and the user picks one. The PROMPTS are written by you (the agent);
the images come from the Gemini image model. When adding a story or
regenerating a header, follow this loop:

1. Get the brief and write the prompts:
   `cd tools && npm run regen-image -- <slug>` prints the story summary, its
   characters (marking those with reference images) and the house rules below.
   Read the transcript in `content/stories/<slug>/story.json`, then write 3
   DISTINCT prompts (different moments, or clearly different treatments of the
   most striking moment) to a JSON array file in your scratchpad.
   (Skip this step if `npm run finalize` already generated candidates from the
   analysis's `headerPrompts`.)
2. Generate: `npm run regen-image -- <slug> --prompts <file.json>`
   (or `--prompt "..."` if the user dictated one exact scene).
3. Show them to the user:
   `open content/stories/<slug>/candidates/gallery.html`
   (the gallery shows the current header too, when one exists)
4. Ask the user to choose (AskUserQuestion works well): candidate 1 / 2 / 3,
   a new batch (collect their feedback), or keep the current image.
5. Act on the answer:
   - pick N → `npm run regen-image -- <slug> --select N`
   - new batch → write 3 new prompts incorporating their feedback and go back
     to step 2 (`--reroll` redraws the same prompts if they just want variants)
   - keep current → `npm run regen-image -- <slug> --discard`

House rules for every image prompt (header, storyboard frame):
- Style, stated in the prompt: a stylish black and white pen and ink
  illustration on a white background; elegant, clean line work; a complete
  scene with a relatively simple, uncluttered background so the characters are
  the clear focus; no busy or dense textures.
- ONE specific moment per prompt; a strong central composition; the setting
  established by a few well-chosen details; each prompt self-contained.
- Reference images: the brief lists which characters have one. For EVERY such
  character in the scene, write their name followed by the exact phrase
  "(as in the image reference)" and keep their own description to a few words.
  Never use that phrase for anyone else.
- No copyrighted or trademarked characters by name: Mickey/Minnie become "a
  cheerful cartoon mouse" / "a friendly animated mouse".

Never overwrite `content/stories/<slug>/source.png` or the served `header.webp`
by any other means, and never select a candidate without the user's explicit
choice. A story with no header yet is a normal state (it publishes without one).

## Transcription: Scribe only, no LLM anywhere in it

ElevenLabs `scribe_v2` is the archive's ONE transcription engine (`ARCHIVE_ENGINE`
in `tools/lib/asr.ts`); there is no engine option on `npm run add` or
`npm run retranscribe`, and no Gemini text call anywhere in the tools. Every
call sends the archive's canonical character and place names as `keyterms` —
built by `tools/lib/lexicon.ts` from `characters.json`/`places.json` by
recurrence, canonical names only, never aliases, CAPPED at 250
(`KEYTERM_SAFE_COUNT`): that covers every name in 2+ stories, and measured on
2026-09-13 Scribe's diarization collapses to one speaker at 300+ keyterms, so
do not raise the cap to "send everything" — and the result is passed through
`content/spellings.json`, the curated list of known mishearings (Haddy →
Hattie, Dimatar → Dimitar, ...) that catches the one-off names too. When you notice a new
mishearing of an existing name in a transcript, add a rule there (unambiguous
names only, never ordinary words; `caseSensitive: true` for anything that is
also a word) rather than hand-editing transcripts. Speaker labels are mapped
to Dad/Izzy from dialogue cues on new recordings and by time-alignment with the
previous transcript on re-transcription; a `low` confidence in the draft or the
retranscribe summary means check the labels.

`npm run retranscribe -- --all --limit N --no-build` re-transcribes the next N
stories not yet done by Scribe+keyterms (tracked in each story's `transcription`
block), oldest first; run `npm run build`, commit and push between batches.
Exit code 3 means the ElevenLabs quota is exhausted — stop and tell the user.
Both tools need the story's local `source.m4a`, which exists only on the
recording Mac.

Engine comparison stays user-driven: `npm run bakeoff -- <slug-or-audio>`
compares Scribe with the OpenAI diarizing model (if its key is set) and writes
`content/bakeoff/<run>/compare.html` — open it and let the user judge (Izzy's
lines are what matters). NEVER declare a winning engine for the user.

## Adding a story: you are the analysis step

The pipeline has no LLM API. `npm run add -- <memo.m4a>` transcribes into
`content/drafts/<id>/` (gitignored) and stops; you write the analysis; then
`npm run finalize -- <id>` does the deterministic rest. Steps:

1. `cd tools && npm run add -- <audio> [--date YYYY-MM-DD]` (or the studio
   upload) → read `content/drafts/<id>/transcript.txt` in full.
2. Write `content/drafts/<id>/analysis.json`:
   ```json
   {
     "title": "creative, catchy, like a picture-book title",
     "summary": "a blurb for the story itself (no meta-commentary about Dad and Izzy telling it), max ~1000 chars",
     "characters": [{ "name": "Hattie the Mouse", "description": "one sentence; used only for NEW entities" }],
     "places": [{ "name": "The Workshop", "description": "..." }],
     "highlightQuote": { "text": "a short, funny/clever/unusual Izzy line, copied VERBATIM from one transcript line" },
     "swapSpeakers": false,
     "headerPrompts": ["...", "...", "..."]
   }
   ```
   - Entities: one entry per individual character or place (never "Ginger,
     Garfield and Alexander" as one entry; a group name only when the story
     names the group, e.g. "The Floofers"). Reuse the EXACT canonical name from
     `content/characters.json` / `places.json` when the entity exists — check
     `aliases` too — so it links to the existing entry; descriptions of existing
     entities are left unchanged. Describe only genuinely new ones.
   - The quote must match a transcript line verbatim (finalize anchors its
     timestamp by exact match and warns otherwise).
   - Set `swapSpeakers: true` if the Dad/Izzy labels are backwards (the draft
     flags a low-confidence mapping).
   - `headerPrompts`: 3 prompts following the house rules above; omit to skip
     candidates (add a header later via `npm run regen-image`).
3. `npm run finalize -- <id> --dry-run` — shows which characters/places would
   be NEW; double-check each new name is not an existing character under a
   different spelling. Then `npm run finalize -- <id>`, which writes the story,
   updates the registries and manifest, rebuilds the site and generates the
   header candidates → continue with the header-image loop above.

## Character registry cleanups are plan-driven and user-reviewed

Duplicate characters (spelling/casing/"X the Mouse" variants) are merged with
`cd tools && npm run merge-characters -- ../content/merge-plans/<plan>.json`
(`--dry-run` first), never by editing `characters.json` or story files by
hand. Write the plan (schema in the header of `tools/merge-characters.ts`),
propose the merges to the user grouped by confidence, and only include a merge
or canonical-name choice the user has confirmed — "same name, different story"
and persona questions (Izzy vs Captain Izzy) are the user's call. Surviving
entities carry `aliases` (the absorbed names), which `npm run add` matches, so
merges stick for future stories. Story slugs are never renamed; the hand-authored
essays (world-dna, dragonet dossier, linguistics report) are not spell-fixed.
Commit the plan file under `content/merge-plans/` with the resulting changes.

## The studio (web GUI)

`cd tools && npm run studio` serves a local web app (LAN-reachable, QR code
printed) covering the parts of the add-story flow that need no LLM: upload a
voice memo → it is transcribed into a draft (listed under "Awaiting analysis in
Claude Code" — you finish it with the steps above) → once finalized, review the
header candidates in the browser, select / re-roll the same prompts / skip, then
publish (buildSite + git commit + push). It reuses the same pipeline
(`tools/lib/add-pipeline.ts`) and the same on-disk drafts and candidate batches
as the CLIs, so studio and CLI runs are interchangeable mid-flow, and the
candidate-selection rules above apply unchanged (selection happens only via an
explicit user tap + confirm). `FAKE_GEMINI=1` stubs the paid calls (canned
transcript, solid-color images) for testing without API spend.

## Storyboards

`cd tools && npm run storyboard -- <slug>` prints the planning brief; you plan
6–12 scenes from the FULL transcript (each: a one-sentence present-tense
caption, a quote copied verbatim from one transcript line — Izzy's funny lines
preferred — and an image prompt in the house style with the reference-image
tags), write them to a JSON file `{ "scenes": [...] }`, and run
`npm run storyboard -- <slug> --plan <file.json>`, which generates one frame per
scene sequentially (character reference images + up to 2 preceding frames as
continuity references). Per-scene redo: `npm run storyboard -- <slug> --scene N
[--prompt "..."]`. The result appears at `#/story/<slug>/storyboard`;
captions/quotes live in `content/stories/<slug>/storyboard/storyboard.json`. If
the user dislikes specific frames, regenerate those scenes rather than
re-running the whole storyboard (a new plan replaces the entire storyboard).

## The forest map (image-based landscape)

The `#/forest` map is a painted Tolkien-style landscape (a raster) with clickable
SVG markers overlaid. `content/forest.json` stays the canonical dataset; the map
is built in three user-driven steps:

1. **Sketch** — `cd tools && npm run forest-sketch` writes
   `content/forest-map/sketch.svg`, a schematic of every region/path/place from
   forest.json, annotated (red notes) to guide the image model. The sketch is
   HAND-OWNED after first generation: forest-sketch refuses to overwrite it
   without `--force`. The user hand-edits it (move the `loc--<id>` circles,
   reshape `path--<id>` curves, retune the notes). Then
   `npm run forest-sketch -- --sync` reads the edited geometry back into
   forest.json — the sketch is the source of truth for positions.
2. **Landscape** — like header images, candidate review is user-driven and a
   candidate is NEVER selected without the user's explicit choice:
   `npm run forest-landscape` generates 3 candidates conditioned on the sketch
   (`--size 1K|2K|4K`, default 2K), writes
   `content/forest-map/candidates/gallery.html`. Then: `--select N` (writes
   `content/forest-map/landscape.png` + the served webp), `--suggest "..."` (new
   batch with feedback), or `--discard`. Landscape only — no buildings/text (the
   prompt forbids them); if the model draws them, regenerate. `FAKE_GEMINI=1`
   stubs generation.
3. **Build/serve** — `npm run build` optimizes `landscape.png` to
   `site/public/media/forest/landscape.webp` and stamps `meta.landscape` into the
   emitted forest.json. When no landscape is selected yet, `meta.landscape` is
   absent and the viewer falls back to the legacy procedural renderer
   (`site/src/forest-legacy.js`); the image engine is `site/src/forest.js`.

`sketch.svg` is committed; `landscape.png` and `candidates/` are gitignored (the
derived `landscape.webp` is committed).

## Publishing

`npm run build` (in `tools/`) regenerates `site/public/{data,media}` — commit
those derived files along with `content/` changes. `content/world-dna.md` is
hand-authored (no generator exists any more): edit the markdown directly. Pushing to `main` deploys via
GitHub Pages when `site/**` changed.
