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

Then, whenever you record a story in iOS Voice Memos, drop the `.m4a` file in and:

```bash
cd tools
npm run add -- "/path/to/My New Story.m4a"
# options: --date 2026-06-20  --no-image  --world-dna  --merge-descriptions
```

This transcribes + analyzes the memo, generates a black-and-white header
illustration, merges any new characters/places into the archive, writes a new
`content/stories/<slug>/`, and rebuilds `site/public`. Reload the site to see it.

Re-running the same audio file is detected (by hash) and rejected, so it's safe.

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

### Regenerating a single story's header image

```bash
cd tools
npm run regen-image -- <story-slug>
# options: --prompt "your own prompt text"   --no-webp
```

It prints the prompt it uses and the list of character reference images fed to the
model, then overwrites `content/stories/<slug>/source.png` and the served
`header.webp`. Pass `--prompt` to dictate the scene yourself; otherwise the prompt
is generated from the story (the `<story-slug>` is the folder name under
`content/stories/`, i.e. the `#/story/<slug>` part of the site URL).

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
