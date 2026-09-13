# Stars & Stories

A private archive of the bedtime stories I make up with my daughter. It's two
pieces that share one dataset:

1. **A static website** (`site/`) — deployed to GitHub Pages. Browse, search and
   sort every story; play the original audio with a timestamp-seeking transcript;
   explore the cast of characters and atlas of places; and see analysis charts +
   a "World DNA" essay. Read-only — no accounts, no database.
2. **Local command-line tools** (`tools/`) — turn a dropped-in iOS voice memo
   into a new story (transcript, summary, characters, places, header image),
   merge it into the archive, and rebuild the site bundle.

```
content/   canonical source of truth (committed text; source media gitignored)
tools/     Node/TS CLIs: migrate, build, add / re-transcribe stories, images
site/      the Vite + React app that becomes the website
```

`content/` is the human-readable source of truth. `site/public/data` and
`site/public/media` are **derived** from it by `tools/build-site.ts` and are
committed so GitHub Pages can serve them directly.

### Standalone pages

`content/dragonet-dossier.html` is a hand-authored page (worldbuilding notes on
the dragonets, drawn from the transcripts) that `npm run build` copies to
`site/public/dragonet-dossier.html`. It is its own document rather than a view in
the SPA — the sidebar links out to it, and it carries its own styles, its own
light/dark tokens (it follows the archive's theme via `localStorage`), and print
rules, so ⌘P produces a paginated US-Letter edition. Edit the file in `content/`
and re-run the build; never edit the copy under `site/public`.
`content/dragonet-dossier.md` holds the same material as plain markdown for
grepping and editing.

`content/linguistics-report.html` is a second such page — a survey of the languages
spoken across the archive (the zoosemiotic languages, the mechanical ones, and the
incantation register), formatted as an academic paper. It follows the same
conventions: `npm run build` copies it to `site/public/linguistics-report.html`, the
sidebar links out to it, and `content/linguistics-report.md` is its plain-markdown
twin. Edit the files in `content/` and re-run the build.

## Viewing / developing the site

```bash
cd site
npm install
npm run dev          # http://localhost:5173
```

To check it the way GitHub Pages serves it (under a base path):

```bash
VITE_BASE=/stars-and-stories/ npm run build
VITE_BASE=/stars-and-stories/ npm run preview
```

## Adding a new story

Prerequisites (one-time):

```bash
brew install ffmpeg                 # used to optimize audio
cd tools
npm install
cp .env.example .env                # then fill in ELEVENLABS_API_KEY (transcription) and GEMINI_API_KEY (images)
npm run verify-models               # confirm the keys / model ids work
```

Adding a story is a three-step flow shared by the studio and the CLI. Two
steps are deterministic tools; the middle one is done by the **Claude Code
agent** working in this repo (there is no LLM API in the pipeline any more; the
only remaining Gemini call is the image model):

1. **Transcribe** — `npm run add -- <memo.m4a>` (or an upload in the studio)
   runs ElevenLabs Scribe with the archive's recurring character and place
   names as keyterms, normalizes known misspellings
   (`content/spellings.json`), maps the two speakers to Dad/Izzy, and writes a
   draft to `content/drafts/<id>/` (`transcript.txt` for reading, `draft.json`
   for the data). Drafts are gitignored flow state.
2. **Analyze** — in Claude Code, read the transcript and write
   `content/drafts/<id>/analysis.json` with the title, summary, characters,
   places, highlight quote and three header-image prompts. CLAUDE.md has the
   schema and the rules (reuse canonical names, quote Izzy verbatim, house
   illustration style).
3. **Finalize** — `npm run finalize -- <id> --dry-run` shows which characters
   and places are new; `npm run finalize -- <id>` writes
   `content/stories/<slug>/`, merges the entities into the registries
   (matching canonical names and aliases), updates the manifest, rebuilds
   `site/public`, and generates the three header candidates for review.

### The studio (easiest way to add a story)

```bash
cd tools
npm run studio
```

This starts a local web app and prints its URL plus a QR code. Open it on the
Mac — or scan the QR code **from your phone on the same wifi** and upload the
voice memo straight from the Voice Memos share sheet / Files app, no transfer
step needed. The studio transcribes the upload into a draft and lists it under
"Awaiting analysis in Claude Code" with the steps to finish it. Once finalized,
the story appears under "Awaiting header review": pick a candidate, re-roll the
same prompts, or skip the header → **Publish**, which rebuilds
`site/public/{data,media}`, commits, and pushes (deploying via GitHub Pages).

Everything the studio does uses the same pipeline and on-disk state as the
CLIs, so the two are interchangeable mid-flow — e.g. a batch generated by
`npm run regen-image` shows up in the studio's review list.

Notes:
- One job runs at a time; a second upload while busy is rejected.
- Anyone on your wifi can reach the studio while it runs. Set `STUDIO_TOKEN`
  in `tools/.env` to require a token (it's embedded in the printed/QR URL).
- `FAKE_GEMINI=1 npm run studio` stubs the paid calls (canned transcript,
  solid-color candidate images) for trying the flow without API spend.

### Adding a story from the command line

Drop the `.m4a` file on the Mac and:

```bash
cd tools
npm run add -- "/path/to/My New Story.m4a"       # options: --date 2026-06-20
#   -> content/drafts/My_New_Story/{transcript.txt, draft.json, source.m4a}
#   ...write content/drafts/My_New_Story/analysis.json (Claude Code)...
npm run finalize -- My_New_Story --dry-run       # check new vs existing entities
npm run finalize -- My_New_Story                 # options: --no-image  --no-build
npm run finalize -- --list                       # drafts awaiting analysis
```

Re-running the same audio file is detected (by hash) and rejected, so it's safe.
The story is published without a header image until you review the candidates
and pick one (see below) — open the printed `gallery.html` and run
`npm run regen-image -- <slug> --select <1|2|3>`.

Transcription details: ElevenLabs `scribe_v2` is the archive's one engine.
Every call sends the archive's canonical character and place names as
`keyterms`, ordered by recurrence and capped at 250 — which covers every name
that appears in two or more stories (canonical names only, never the absorbed
misspellings) — plus `language_code=en` and `num_speakers=2`. The cap is
deliberate: measured on 2026-09-13, Scribe diarizes correctly with up to 250
keyterms but collapses to a single speaker at 300 or more, and the API's
nominal 1000 gives nondeterministic speaker counts (`KEYTERM_SAFE_COUNT` in
`tools/lib/lexicon.ts`). The result is then passed through
`content/spellings.json` — a curated list of known mishearings (Haddy → Hattie,
Dimatar → Dimitar, Murgirl → Mergirl, ...) — so new transcripts match the
archive's spellings, one-off names included. Add a rule there when a new
mishearing shows up; keep it to unambiguous names, never ordinary words.
Scribe's anonymous `speaker_0/1` labels are mapped to Dad/Izzy from dialogue
cues (who says "Daddy", who says "Izzy", line length); the draft flags a
low-confidence mapping so you can set `"swapSpeakers": true` in the analysis.

### Comparing transcription engines (bake-off)

To judge how Scribe hears Izzy against another engine, run the same recording
through both and review them side by side:

```bash
cd tools
npm run bakeoff -- <slug-or-audio-path> [more inputs...]
# options: --engines scribe-v2,openai-diarize   --name label
```

An engine is skipped (with a note) when its API key is missing from
`tools/.env`: ElevenLabs Scribe (`ELEVENLABS_API_KEY`, ~$0.22/audio-hour plus
20% for keyterms, acoustic diarization included) and OpenAI (`OPENAI_API_KEY`,
~$0.36/audio-hour, native diarization). Both receive the same keyterm list.

Each run writes `content/bakeoff/<name>-<stamp>/` (gitignored) with per-engine
JSON and a `compare.html`: one column per engine, Izzy's lines highlighted,
click any line to play from there, and during playback every column highlights
the line at the current time — an engine with drifting timestamps visibly
tracks the wrong line. The header of each column shows the Dad/Izzy mapping so
a flipped one is easy to spot.

Judging tip: listen to Izzy's hardest lines at 0.75× speed and compare what
each engine heard. Requires the story's local `source.m4a` (or any audio path).

### Re-transcribing existing stories

```bash
cd tools
npm run retranscribe -- <slug>                       # one story
npm run retranscribe -- --all --limit 15 --no-build  # the next 15 not yet done by Scribe+keyterms
# options: --force (redo stories already marked done)   --no-build
```

Replaces ONLY the transcript (and the per-speaker word counts) of existing
stories using Scribe with the keyterm list. The slug, title, date,
summary, characters, places, header image and the highlight quote's text are
preserved; the quote's timestamp is re-located against the new transcript and
otherwise keeps its old value (same audio, same timeline). Each story records
how its transcript was made in a `transcription` block (engine, model, keyterm
count, speaker mapping), which is what `--all` uses to skip finished stories —
so a long batch can be run in chunks, committed between chunks, and resumed.
When re-transcribing, speakers are mapped by aligning the new segments with the
previous transcript's Dad/Izzy labels in time; low-confidence mappings are
listed at the end for a glance. The tool exits with code 3 when ElevenLabs
reports the quota is exhausted (nothing half-written). Requires the story's
local `source.m4a`. Review with `git diff content/stories/<slug>/story.json`
and revert with `git checkout` if the new transcript isn't better.

### Character reference images

Some characters have a reference portrait (from the world-inventory export,
`StarsAndStories_World_Inventory_*/characters/<Name>/image.*`). Import them once:

```bash
cd tools
npm run import-images   # matches each by name -> content/characters/<id>/reference.*
npm run build           # optimizes them -> site/public/media/characters/*.webp
```

This shows the portrait on the character's card in the site's **Characters** view,
and — more importantly — feeds the image as a reference whenever a header image is
generated for a story that character appears in (so they stay visually consistent).
When the prompt mentions such a character it tags them `(as in the image reference)`.

Originals (`content/characters/**/reference.*`) are kept out of git like the other
source media; the optimized webp under `site/public/media/characters` is committed.

### Merging duplicate characters

The registry accumulates duplicates as the transcription and analysis passes
hear a name differently across stories (Hattie / Haddy / Hatty, Dimitar /
Dimatar / Demitar, "Finn" / "Finn Cat" / "Finncat"...). Clean them up with a
reviewed merge plan rather than by hand:

```bash
cd tools
npm run merge-characters -- ../content/merge-plans/<plan>.json --dry-run   # preview
npm run merge-characters -- ../content/merge-plans/<plan>.json             # apply + rebuild
```

A plan (see `content/merge-plans/` for a real one, and the header comment of
`tools/merge-characters.ts` for the schema) lists which entity survives each
merge, which entities it absorbs, and word-level spelling rules. Applying it
rewrites the embedded character refs in every `story.json`, fixes the spellings
in titles, summaries, highlight quotes, transcripts and descriptions (and in the
denormalized copies inside `worlds.json`, `forest.json` and storyboard captions),
recomputes word counts, retires the losing reference images to
`content/characters/_retired/<id>/`, and records every absorbed name as an
`aliases` entry on the survivor so that `npm run add` and `npm run import-images`
match the old spelling next time instead of creating a new duplicate.

Story slugs (folder names and URLs) are never renamed, and the hand-authored
essays (`world-dna.md`, the dragonet dossier, the linguistics report) are left
alone — they document the spelling variation deliberately.

### Choosing / regenerating a story's header image

Header images go through a candidate-review flow — the existing header is never
replaced until you approve a new one. The prompts are written by the Claude Code
agent (the tool prints the brief); the images come from the Gemini image model:

```bash
cd tools
npm run regen-image -- <story-slug>                        # print the prompt brief (summary, characters, rules)
npm run regen-image -- <story-slug> --prompts prompts.json # 3 candidates, one per prompt in the file
open ../content/stories/<story-slug>/candidates/gallery.html   # review them side by side
npm run regen-image -- <story-slug> --select 2             # promote candidate 2 to the header
```

Not happy with the batch? Either of:

```bash
npm run regen-image -- <story-slug> --reroll     # same prompts, new images
npm run regen-image -- <story-slug> --discard    # keep the current image
```

(or have Claude Code write a new prompts file from your feedback.) Pass
`--prompt "..."` to dictate one exact scene (still produces 3 treatments of
it). Each run prints the prompts and the character reference images fed to the
model. Only `--select` writes `content/stories/<slug>/source.png` and re-encodes
the served `header.webp`; the candidates live in the gitignored
`content/stories/<slug>/candidates/` (the `<story-slug>` is the folder name under
`content/stories/`, i.e. the `#/story/<slug>` part of the site URL).

### Generating a storyboard

A storyboard is an ordered sequence of illustrated scenes (with captions and a
verbatim quote per scene) that tells the whole story, shown on its own page at
`#/story/<slug>/storyboard`:

```bash
cd tools
npm run storyboard -- <story-slug>                    # print the planning brief
npm run storyboard -- <story-slug> --plan plan.json   # install the plan + generate every frame
# options: --plan-only   --no-webp   --no-build
```

The Claude Code agent plans the scenes from the full transcript (usually 6–12,
favoring the funny/unusual moments; each scene has a caption, a quote copied
verbatim from one transcript line, and an image prompt in the house style), and
the tool generates the frames sequentially — each frame gets the character
reference images plus up to two preceding frames as continuity references. Redo
a single frame with:

```bash
npm run storyboard -- <story-slug> --scene 4                     # regenerate frame 4
npm run storyboard -- <story-slug> --scene 4 --prompt "..."      # ...with your own prompt
```

The plan lives in `content/stories/<slug>/storyboard/storyboard.json`
(committed); frames are `scene-NN.png` next to it (gitignored) with served webps
under `site/public/media/<slug>/storyboard/` (committed).

### The "World DNA" essay

`content/world-dna.md` is hand-authored (its quotes are verified against the
transcripts). Edit the markdown directly and run `npm run build` to publish it;
there is no generator.

## Deploying

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds `site/`
and publishes it to GitHub Pages. In the repo's **Settings → Pages**, set the
source to **GitHub Actions**.

- The workflow sets `VITE_BASE=/<repo>/` automatically. If you use a custom
  domain or a `user.github.io` page, change `VITE_BASE` to `/` in the workflow.
- The optimized media in `site/public/media` (~600 MB) is committed and served
  as-is; CI does not need ffmpeg.

## Re-running the one-time migration

The dataset was created from the original AI Studio export with:

```bash
cd tools
npm run import      # data export -> content/
npm run build       # content/ -> site/public/{data,media}  (encodes media)
```

`npm run build` accepts `--force` to re-encode existing media. Audio bitrate /
image quality are tunable via `AUDIO_BITRATE`, `WEBP_QUALITY`, `WEBP_WIDTH`.
