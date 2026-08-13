# Harvest tools

One-off importers and derivation tools, moved here as-is from
`WorshipCommonsApi/tools` at the 2026-08 content-library cutover. They produced
this library's content; they are **not** needed to consume it.

**They do not run unmodified.** They still reference the old API-repo layout —
`src/seed-data/*.ts` TS literal files and `tools/seed-assets/` — both retired.
Next time one is needed, rework its output to write song folders here instead
(`songs/<lang>/<license>/<slug>/` + `song.json`), then run
`../write-sources-txt.mjs`, `../build-catalog.mjs`, `../validate.mjs`.

| Tool | What it harvested |
|---|---|
| `import-openhymnal.ts` | Open Hymnal ABC corpus → texts, ABC, MIDIs |
| `import-cyberhymnal.ts` + `cyberhymnal-aliases.json` | Cyber Hymnal MIDIs (via Wayback) |
| `import-tch-spanish.ts`, `import-tch-lang.ts` | Cyber Hymnal language sections → texts + MIDIs |
| `import-hymnsite.ts` | HymnSite umh### MIDIs |
| `import-hymnary-spanish.ts`, `import-hymnary-popularity.ts` | Hymnary PD Spanish texts, hymnal counts |
| `import-writer-portraits.ts` | Wikipedia/Commons portraits + bios |
| `import-videos.ts` + `video-report.txt` | Curated YouTube performances |
| `backfill-chords.py`, `backfill-verses.ts` | Chords/verses derived from the ABC corpus |
| `generate-lyric-timings.py` | Karaoke word timings from ABC + MIDI |
| `trim-midi-tails.py` | MIDI cleanup |
| `sync-cover-art.ts` | Matched loose cover-art files to songs by title (obsolete: drop `art.webp` into the song folder directly) |

Python tools need `mido`, `music21`, and abc2xml (not vendored — see each file's header).
