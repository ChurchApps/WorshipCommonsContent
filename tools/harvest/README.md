# Harvest tools

One-off importers and derivation tools, moved here as-is from
`WorshipCommonsApi/tools` at the 2026-08 content-library cutover. They produced
this library's content; they are **not** needed to consume it.

Most still reference the old API-repo layout (`src/seed-data/*.ts`, `tools/seed-assets/`)
and do not run unmodified. Reworked importers (`import-openhymnal.mjs`, `import-cmpilato.mjs`,
`import-cmaa.mjs`, `import-mutopia.mjs`) write `songs/<lang>/<license>/<slug>/` + `song.json`,
then run `../write-sources-txt.mjs`, `../build-catalog.mjs`, `../validate.mjs`.

| Tool | What it harvested |
|---|---|
| `import-openhymnal.mjs` | Open Hymnal PD ABC/MIDI newer than 2014.06 → `songs/en/public-domain/<slug>/` (`import-openhymnal.ts` is the retired 2014.06 seed-data parser) |
| `import-cyberhymnal.ts` + `cyberhymnal-aliases.json` | Cyber Hymnal MIDIs (via Wayback) |
| `import-tch-spanish.ts`, `import-tch-lang.ts` | Cyber Hymnal language sections → texts + MIDIs |
| `import-hymnsite.ts` | HymnSite umh### MIDIs |
| `import-hymnary-spanish.ts`, `import-hymnary-popularity.ts` | Hymnary PD Spanish texts, hymnal counts |
| `import-hymnary-meter.mts` | Hymnary poetic meter into `song.json` (reworked for this layout — it runs) |
| `import-cmpilato.mjs` | github.com/cmpilato/worship-music clone → CC-BY 3.0 / PD song folders |
| `import-cmaa.mjs` | CMAA newly-composed PDFs whose *file* grant is CC BY 3.0 (skips ND, NC, "except commercial", CanticaNOVA) |
| `import-mutopia.mjs` | Mutopia hymn SATB letter PDFs → sheetPdf on matching PD songs; Foundation as CC-BY-SA 2.0 |
| `import-writer-portraits.ts` | Wikipedia/Commons portraits + bios |
| `import-videos.ts` + `video-report.txt` | Curated YouTube performances |
| `backfill-chords.py`, `backfill-verses.ts` | Chords/verses derived from the ABC corpus |
| `backfill-coverage.py` | MusicXML harmony → ChordPro + MIDI + karaoke; `--partial` copies verse-1 chords onto later verses (reflows syllable-broken lines) |
| `scan-coverage.mjs` | Catalog report: chords / partial chords / MIDI / karaoke / PDF gaps |
| `generate-lyric-timings.py` | Karaoke word timings from ABC + MIDI |
| `trim-midi-tails.py` | MIDI cleanup |
| `sync-cover-art.ts` | Matched loose cover-art files to songs by title (obsolete: drop `art.webp` into the song folder directly) |

Python tools need `mido`, `music21`, and abc2xml (not vendored — see each file's header).
