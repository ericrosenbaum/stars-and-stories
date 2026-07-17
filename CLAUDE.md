# Stars & Stories — Claude workflows

A family story archive: `content/` is the canonical data, `tools/` holds Node/tsx
CLIs (run them from `tools/`), `site/` is a Vite + React SPA served from the
committed `site/public/{data,media}` bundle built by `npm run build`. See
README.md for the full tool reference.

## Header images: candidate review is user-driven

Header images are NEVER written directly — every generation produces 3
candidates and the user picks one. When adding a story (`npm run add`) or
regenerating a header, follow this loop:

1. Generate candidates (skip if `npm run add` already did):
   `cd tools && npm run regen-image -- <slug>`
   (use `--prompt "..."` if the user dictated a scene)
2. Show them to the user:
   `open content/stories/<slug>/candidates/gallery.html`
   (the gallery shows the current header too, when one exists)
3. Ask the user to choose (AskUserQuestion works well): candidate 1 / 2 / 3,
   a new batch (collect their feedback), or keep the current image.
4. Act on the answer:
   - pick N → `npm run regen-image -- <slug> --select N`
   - new batch → `npm run regen-image -- <slug> --suggest "<their feedback>"`,
     then go back to step 2
   - keep current → `npm run regen-image -- <slug> --discard`

Never overwrite `content/stories/<slug>/source.png` or the served `header.webp`
by any other means, and never select a candidate without the user's explicit
choice. A story with no header yet is a normal state (it publishes without one).

## Transcription

New stories are transcribed in two passes: an audio → transcript pass (default
engine: ElevenLabs `scribe-v2`) followed by a Gemini transcript → analysis pass
(title/entities/summary/quote). The transcription prompt is primed with recurring
character/place names via `tools/lib/lexicon.ts`. Override the engine per-run with
`npm run add -- <audio> --engine <id>`, or globally via `TRANSCRIBE_ENGINE` in
`tools/.env`; `defaultEngine()` in `tools/lib/asr.ts` is the single source of truth.

Engine comparison is user-driven, like header candidates:
`cd tools && npm run bakeoff -- <slug-or-audio>` runs the recording through
the configured engines and writes `content/bakeoff/<run>/compare.html` — open
it and let the user judge (Izzy's lines are what matters). NEVER declare a
winning engine for the user. Engines missing API keys are skipped, that's
normal.

`npm run retranscribe -- <slug> [--engine X] [--quote]` replaces only the
transcript + word counts of an existing story (title/date/summary/entities/
header image preserved). Both tools need the story's local `source.m4a`, which
exists only on the recording Mac — they fail with a clear message elsewhere.

## The studio (web GUI)

`cd tools && npm run studio` serves a local web app (LAN-reachable, QR code
printed) covering the whole add-story flow: upload a voice memo, review header
candidates in the browser, select/regen/skip, then publish (buildSite + git
commit + push). It reuses the same pipeline (`tools/lib/add-pipeline.ts`, which
transcribes with the default engine) and the same on-disk candidate batches as
the CLIs, so studio and CLI runs are interchangeable mid-flow, and the
candidate-selection rules above apply unchanged (selection happens only via an
explicit user tap + confirm). `FAKE_GEMINI=1` stubs all Gemini calls for testing
without API spend.

## Storyboards

`cd tools && npm run storyboard -- <slug>` plans 6–12 scenes from the full
transcript and generates one frame per scene sequentially (character reference
images + up to 2 preceding frames as continuity references). Per-scene redo:
`npm run storyboard -- <slug> --scene N [--prompt "..."]`. The result appears at
`#/story/<slug>/storyboard`; captions/quotes live in
`content/stories/<slug>/storyboard/storyboard.json`. If the user dislikes
specific frames, regenerate those scenes rather than re-running the whole
storyboard (a full re-run replaces the entire plan and all frames).

## Publishing

`npm run build` (in `tools/`) regenerates `site/public/{data,media}` — commit
those derived files along with `content/` changes. Pushing to `main` deploys via
GitHub Pages when `site/**` changed.
