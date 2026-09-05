# Transcription review — Sept 2026

A costing/feasibility estimate for re-transcribing the archive. Nothing here
changes any transcript; it's the input to that decision.

## 1. Which engine produced which story

`story.json` records no engine, so this is reconstructed from git history —
which commit first added each `story.json`, and what the pipeline's default
engine was at that point (`defaultEngine()` in `tools/lib/asr.ts`).

| cohort | n | audio | mean | how it was transcribed |
|---|---|---|---|---|
| legacy export | 186 | 31.97 h | 10.3 min | AI Studio pipeline, imported wholesale in `5eaa704` (2026-06-20) via `import-export.ts`. One-pass Gemini (`gemini-3.5-flash` era), transcript + analysis in a single call. |
| local Gemini | 10 | 2.98 h | 17.9 min | `npm run add` between `42b8cec` (06-21) and `8029685` (07-12), still one-pass Gemini. |
| scribe-v2 | 16 | 5.34 h | 20.0 min | Everything after `6a9f54b` (07-17), which made ElevenLabs `scribe-v2` the default and split transcription into the audio pass + Gemini analysis pass. |
| **total** | **212** | **40.28 h** | 11.4 min | |

Durations are read from the `mvhd` atom of each `site/public/media/<slug>/audio.m4a`.
No story has ever been re-transcribed — the only post-add edit to any
`story.json` is `51cee5f` ("Fix names in…"), a hand fix.

So **196 of 212 stories (34.9 h, 87%) have never been through the current
pipeline.**

## 2. Is scribe-v2 still the right default?

### The in-repo evidence says the 07-17 switch helped

Izzy's words captured per minute of audio, by month, holds the recording
constant and shows a step at the engine switch:

```
2026-05  legacy    36.6 wpm      2026-07  scribe-v2  53.7 wpm
2026-06  legacy    36.6 wpm      2026-08  scribe-v2  53.8 wpm
2026-07  gemini    39.5 wpm      2026-09  scribe-v2  44.1 wpm  (n=3)
```

Izzy's share of the transcript goes 29.8% (legacy) → 34.7% (local Gemini) →
42.4% (scribe-v2). Some of that is a 2-year-old becoming a 3-year-old and
talking more, but the jump lands on the engine boundary, not on a birthday:
the same months either side of 07-17 differ by ~35%. The plausible reading is
that Gemini was dropping quiet/mumbled child speech that scribe-v2 hears.

### The bigger problem is names, not words

757 characters and 569 places, of which 619 and 459 respectively appear in
exactly one story. A similarity sweep finds **182 near-duplicate character-name
pairs** — `Mergirl`/`Murgirl`, `Bobizzard`/`Bobizard`, `Seeker`/`Seker`,
`Wobble`/`Wobbly`/`Wabble`, `Catasory`/`Catasorry`/`Cadasori`. Every one of
those inflates the entity registry and breaks the codex cross-links.

`tools/lib/lexicon.ts` exists to fix exactly this — but **the lexicon never
reaches scribe-v2.** In `runEngine()`, `opts.lexicon` is passed only on the
`gemini-flash`/`gemini-pro` branches; `runScribe()` sends `file`, `model_id`
and `diarize` and nothing else. So the current default engine is the one
engine running with no name priming at all. ElevenLabs supports this via the
`keyterms` param (up to 1000 terms × 50 chars on Scribe v2, +$0.05/hr), and
the lexicon caps at 120 characters + 60 places — well inside that budget.

**This is the cheapest available accuracy win and it doesn't require changing
engines.** Worth doing before any bulk re-transcription, so the re-run gets
the benefit.

### The one engine worth bake-off-ing against it

The field hasn't moved much since 07-17. There is no Scribe v3, no Deepgram
Nova-4. Two things did change:

- **AssemblyAI Universal-3.5 Pro** (mid-2026) is the notable one. On the
  diarization benchmark it posts 30.17 cpWER vs Scribe v2's 35.26 and
  Nova-3's 37.92 — and cpWER is precisely this project's metric, since
  "who said what" is what the Izzy/Dad split depends on. $0.21/hr async
  with diarization *and* keyterm prompting (1,500 words) included, i.e.
  slightly cheaper than Scribe v2 + the keyterm add-on. Caveat: those
  numbers are AssemblyAI's own published benchmark; the independent Coval
  round-up is behind a blocked domain and I couldn't verify it.
- **OpenAI `gpt-transcribe`** (2026-07-28) replaced `gpt-4o-transcribe` as
  the default file-transcription model at $0.0045/min ($0.27/hr). The repo's
  `openai-diarize` engine still points at `gpt-4o-transcribe-diarize`.
  Diarization support on the new model is unconfirmed — worth checking before
  bothering.

Nobody publishes child-speech benchmarks; the literature (fine-tuned Whisper
on JASMIN/DART) says adult-tuned WER doesn't transfer to a 3-year-old. So the
vendor numbers only pick who enters the bake-off — `npm run bakeoff` on 2–3
recordings, judged on Izzy's lines, decides it. That judgment is yours, not
mine.

## 3. What re-transcription would cost

Rates per hour of audio: AssemblyAI Universal-3.5 Pro $0.21 (diarization +
keyterms included) · Scribe v2 $0.22 · Scribe v2 + keyterms $0.27 ·
Deepgram Nova-3 $0.258 · OpenAI `gpt-transcribe` $0.27.

| scope | hours | AssemblyAI | Scribe v2 | Scribe + keyterms |
|---|---|---|---|---|
| Top 50 pre-scribe stories by Izzy word count | 13.5 | $2.84 | $2.97 | $3.65 |
| Legacy export only (186) | 32.0 | $6.71 | $7.03 | $8.63 |
| All pre-scribe (196) | 34.9 | $7.34 | $7.69 | $9.43 |
| Whole archive (212) | 40.3 | $8.46 | $8.86 | $10.87 |

Plus the per-story Gemini speaker-mapping call (`mapSpeakersWithGemini`),
~$0.29 for all 212. A 3-engine bake-off on 3 recordings is under $0.10.

**The money is a rounding error — under $11 to redo everything.** The real
costs are elsewhere:

- **The originals live on the recording Mac.** `retranscribe.ts` needs
  `content/stories/<slug>/source.m4a`, which is gitignored. The committed
  `site/public/media/*/audio.m4a` are 40 kbps mono re-encodes built for
  intelligibility, not accuracy — re-transcribing from those would hand the
  new engine worse audio than the old one got, which defeats the purpose.
  Any bulk run happens on the Mac.
- **Highlight quotes.** `retranscribe` keeps the quote text and re-locates its
  timestamp against the new transcript. When the new transcript words the line
  differently the timestamp goes `null` and the quote stops seeking. Across
  196 stories that will happen a nonzero number of times and each one is a
  manual fix.
- **Review burden.** 196 diffs against a hand-curated archive. Entity
  registries recompute, word counts shift, and the codex/linguistics/dossier
  documents are all derived from transcript text.

## 4. Suggested order

1. Pass the lexicon to `runScribe()` as `keyterms` (+$0.05/hr). Cheap, and it
   is the actual named-entity fix.
2. `npm run bakeoff` on 2–3 recordings — ideally one legacy story where you
   remember what Izzy actually said — against `scribe-v2` (with keyterms) and
   an AssemblyAI engine, if adding one is worth it. Judge it yourself.
3. Re-transcribe in tiers rather than all at once: the ~50 highest-Izzy-content
   pre-scribe stories first ($3), review those diffs, then decide about the
   remaining 146.

Prices are from vendor pricing pages via search (their sites are blocked from
this sandbox) and match the constants already in `tools/lib/asr.ts`; spot-check
before committing to a bulk run.
