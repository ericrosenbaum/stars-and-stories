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
tools/     Node/TS CLIs: migrate, build, add a story, regenerate the essay
site/      the Vite + React app that becomes the website
```

`content/` is the human-readable source of truth. `site/public/data` and
`site/public/media` are **derived** from it by `tools/build-site.ts` and are
committed so GitHub Pages can serve them directly.

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
cp .env.example .env                # then put your GEMINI_API_KEY in .env
npm run verify-models               # confirm the Gemini model ids still work
```

If `verify-models` reports a model is invalid, set `GEMINI_TEXT_MODEL` and/or
`GEMINI_IMAGE_MODEL` in `tools/.env` to a current Gemini model id.

### The studio (easiest way to add a story)

```bash
cd tools
npm run studio
```

This starts a local web app and prints its URL plus a QR code. Open it on the
Mac — or scan the QR code **from your phone on the same wifi** and upload the
voice memo straight from the Voice Memos share sheet / Files app, no transfer
step needed. The studio walks the whole flow: upload → transcribe & analyze →
review the three header candidates side by side → pick one (or request a new
batch with feedback, or skip the header) → **Publish**, which rebuilds
`site/public/{data,media}`, commits, and pushes (deploying via GitHub Pages).

Everything the studio does uses the same pipeline and on-disk state as the
CLIs below, so the two are interchangeable mid-flow — e.g. a batch generated
by `npm run add` shows up in the studio's "Awaiting header review" list.

Notes:
- One job runs at a time; a second upload while busy is rejected.
- Anyone on your wifi can reach the studio while it runs. Set `STUDIO_TOKEN`
  in `tools/.env` to require a token (it's embedded in the printed/QR URL).
- `FAKE_GEMINI=1 npm run studio` stubs the Gemini calls (canned transcript,
  solid-color candidate images) for trying the flow without API spend.

### Adding a story from the command line

Alternatively, drop the `.m4a` file on the Mac and:

```bash
cd tools
npm run add -- "/path/to/My New Story.m4a"
# options: --date 2026-06-20  --engine scribe-v2  --no-image  --world-dna  --merge-descriptions
```

This transcribes + analyzes the memo, merges any new characters/places into the
archive, writes a new `content/stories/<slug>/`, generates **three candidate**
black-and-white header illustrations, and rebuilds `site/public`. The story is
published without a header image until you review the candidates and pick one
(see the next section) — open the printed `gallery.html` and run
`npm run regen-image -- <slug> --select <1|2|3>`.

Re-running the same audio file is detected (by hash) and rejected, so it's safe.

Transcription runs in two focused passes: an audio pass that only transcribes
and labels the two speakers (default engine: ElevenLabs `scribe-v2`, primed with
the most recurring character/place names from the archive so familiar names are
spelled consistently), then a Gemini text pass that produces the title, entities,
summary and highlight quote. Pick the audio engine per-run with `--engine <id>`
(`scribe-v2` | `gemini-flash` | `gemini-pro` | `openai-diarize`) or globally via
`TRANSCRIBE_ENGINE` in `tools/.env`. When the audio pass runs on Gemini, set
`GEMINI_TRANSCRIBE_MODEL` to use a stronger model (e.g. a Pro tier) while analysis
stays on the cheap one, and files over ~15 MB upload via the Gemini Files API
automatically.

### Comparing transcription engines (bake-off)

To judge which engine hears Izzy best, run the same recording through several
engines and review them side by side:

```bash
cd tools
npm run bakeoff -- <slug-or-audio-path> [more inputs...]
# options: --engines gemini-flash,gemini-pro,scribe-v2,openai-diarize   --name label
```

Engines are skipped (with a note) when their API key is missing from
`tools/.env`: Gemini needs `GEMINI_API_KEY`, ElevenLabs Scribe
(`ELEVENLABS_API_KEY`, ~$0.22/audio-hour, acoustic diarization included) and
OpenAI (`OPENAI_API_KEY`, ~$0.36/audio-hour, native diarization). Gemini costs
fractions of a cent per story. `npm run verify-models` checks whichever keys
are configured.

Each run writes `content/bakeoff/<name>-<stamp>/` (gitignored) with per-engine
JSON and a `compare.html`: one column per engine, Izzy's lines highlighted,
click any line to play from there, and during playback every column highlights
the line at the current time — an engine with drifting timestamps visibly
tracks the wrong line. The acoustic engines' anonymous `speaker_0/1` labels are
mapped to Dad/Izzy by a small Gemini call (word-share fallback); the header of
each column shows the mapping so a flipped one is easy to spot.

Judging tip: listen to Izzy's hardest lines at 0.75× speed and compare what
each engine heard. Requires the story's local `source.m4a` (or any audio path).

### Re-transcribing an existing story

```bash
cd tools
npm run retranscribe -- <slug>
# options: --engine scribe-v2|gemini-flash|gemini-pro|openai-diarize (default scribe-v2)   --quote   --no-build
```

Replaces ONLY the transcript (and the per-speaker word counts) of an existing
story using the default engine or another one. The slug, title, date,
summary, characters, places and header image are preserved. The highlight
quote's text is kept and its timestamp re-located against the new transcript;
pass `--quote` to pick a fresh quote instead. Requires the story's local
`source.m4a`. Review with `git diff content/stories/<slug>/story.json` and
revert with `git checkout` if the new transcript isn't better.

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

### Choosing / regenerating a story's header image

Header images go through a candidate-review flow — the existing header is never
replaced until you approve a new one:

```bash
cd tools
npm run regen-image -- <story-slug>              # generate 3 candidates (different scenes)
open ../content/stories/<story-slug>/candidates/gallery.html   # review them side by side
npm run regen-image -- <story-slug> --select 2   # promote candidate 2 to the header
```

Not happy with the batch? Either of:

```bash
npm run regen-image -- <story-slug> --suggest "more snow, show the fish house"  # new batch with feedback
npm run regen-image -- <story-slug> --discard                                   # keep the current image
```

Pass `--prompt "..."` to dictate the exact scene yourself (still produces 3
treatments of it). Each run prints the prompts and the character reference
images fed to the model. Only `--select` writes `content/stories/<slug>/source.png`
and re-encodes the served `header.webp`; the candidates live in the gitignored
`content/stories/<slug>/candidates/` (the `<story-slug>` is the folder name under
`content/stories/`, i.e. the `#/story/<slug>` part of the site URL).

### Generating a storyboard

A storyboard is an ordered sequence of illustrated scenes (with captions and a
verbatim quote per scene) that tells the whole story, shown on its own page at
`#/story/<slug>/storyboard`:

```bash
cd tools
npm run storyboard -- <story-slug>               # plan scenes + generate every frame
# options: --scenes 8   --plan-only   --no-webp   --no-build
```

Gemini plans the scenes from the full transcript (usually 6–12, favoring the
funny/unusual moments), then generates the frames sequentially — each frame gets
the character reference images plus up to two preceding frames as continuity
references. Redo a single frame with:

```bash
npm run storyboard -- <story-slug> --scene 4                     # regenerate frame 4
npm run storyboard -- <story-slug> --scene 4 --prompt "..."      # ...with your own prompt
```

The plan lives in `content/stories/<slug>/storyboard/storyboard.json`
(committed); frames are `scene-NN.png` next to it (gitignored) with served webps
under `site/public/media/<slug>/storyboard/` (committed).

### Refreshing the "World DNA" essay

The deep-analysis essay isn't part of the data export. Generate or refresh it:

```bash
cd tools
npm run world-dna && npm run build
```

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
