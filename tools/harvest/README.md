# Harvest tools

One-off importers and derivation tools, moved here as-is from
`WorshipCommonsApi/tools` at the 2026-08 content-library cutover. They produced
this library's content; they are **not** needed to consume it.

Most still reference the old API-repo layout (`src/seed-data/*.ts`, `tools/seed-assets/`)
and do not run unmodified. Reworked importers (`import-openhymnal.mjs`, `import-cmpilato.mjs`,
`import-cmaa.mjs`, `import-mutopia.mjs`) write `songs/<lang>/<license>/<slug>/` packages
(`sources/` + `masters/` + `derivatives/`), then run `../write-sources-txt.mjs`,
`../build-catalog.mjs`, `../validate.mjs`.

| Tool | What it harvested |
|---|---|
| `import-openhymnal.mjs` | Open Hymnal PD ABC/MIDI newer than 2014.06 → `songs/en/public-domain/<slug>/` (`import-openhymnal.ts` is the retired 2014.06 seed-data parser) |
| `import-cyberhymnal.ts` + `cyberhymnal-aliases.json` | Cyber Hymnal MIDIs (via Wayback) |
| `import-tch-spanish.ts`, `import-tch-lang.ts` | Cyber Hymnal language sections → texts + MIDIs |
| `import-hymnsite.ts` | HymnSite umh### MIDIs |
| `import-hymnary-spanish.ts`, `import-hymnary-popularity.ts` | Hymnary PD Spanish texts, hymnal counts |
| `import-ccli.mjs` | Conservative CCLI SongSelect ids into `sources/ccli.json` from `ccli-verified.json` (title + historical author; prefers the work whose SongSelect slug names the standard hymn tune). Does not scrape lyrics/charts. `--dry`. After apply: `node tools/build-catalog.mjs` && `node tools/validate.mjs` |
| `import-hymnary-meter.mts` | Hymnary poetic meter into `song.json` (reworked for this layout — it runs) |
| `import-cmpilato.mjs` | github.com/cmpilato/worship-music clone → CC-BY 3.0 / PD song folders |
| `import-cmaa.mjs` | CMAA newly-composed PDFs whose *file* grant is CC BY 3.0 (skips ND, NC, "except commercial", CanticaNOVA) |
| `import-freely-giving.mjs` | Original congregational songs listed at freely.giving/music with an explicit PD/CC0 dedication (Kevin Kwon; Mark Feezell originals). Skips All-Rights-Reserved lyric sheets, ESV psalm settings, and instrumental hymn arrangements of songs already in the catalog |
| `import-andrew-case.py` | Andrew Case originals at hismagnificence.com/music/ after author PD confirmation 2026-09-14. Skips Sing Hebrew, third-party covers, ESV psalm sheets, Coca-Cola jingle, instrumentals without lyrics, duplicate mixes. After import: `node tools/generate.mjs <pkg>` then `python tools/pack/build.py <pkg>` (stems + MIDI/MusicXML from the vocal stem) |
| `import-larry-holder.py` | Larry Holder worship songs at larryholdermusic.org (and Elton Smith co-writes linked from there on songsofpraise.org) under the custom `larry-holder` grant. Elton granted under Larry’s terms. Skips every other co-writer (any name on a Written/Words/Music by line that is not Larry or Elton), novelty tracks, hymn adaptations, and photos. Tempo/key/time come from the writer's MIDI; theme from the site's category shelf; stage directions become section labels and `{c:}` cues; leftover mp3/mid/pdf go to `sources/extra/`. Copyright, credits, and site notes are stripped from lyrics (`--strip-chrome` for existing packages). `--refresh` re-parses existing packages (keeps hand-set themes, scripture, ccli and foreign manifest rows). After import: `node tools/generate.mjs <pkg>` then `python tools/pack/build.py <pkg>` for songs with a master |
| `import-mutopia.mjs` | Mutopia hymn SATB letter PDFs → sheetPdf on matching PD songs; Foundation as CC-BY-SA 2.0 |
| `import-writer-portraits.ts` | Wikipedia/Commons portraits + bios |
| `import-videos.ts` + `video-report.txt` | Curated YouTube performances |
| `fill-lyrics-only-chords.py` | Legal chord-fill for remaining lyrics-only rows: inherit from a charted parent (or TCH-slug English original), attach Open Hymnal PD ABC (`C: public domain`; skip worship-only Dumont/Medcalf/Bird), then Cyber Hymnal MusicXML via Hymnary. Does not scrape SongSelect/UG or HymnSite sequences. `--dry-run`, `--skip-hymnary`. After a fill: `node tools/generate.mjs` then `node tools/build-catalog.mjs` && `node tools/validate.mjs` |
| `backfill-chords.py` | Chords derived from the ABC corpus (legacy seed-data paths) |
| `backfill-library-chords.py` | Package-layout SATB ABC → inline ChordPro chords. `--expand` appends verses the ABC already underlays that the curated seed omitted (verse-1-only mockup charts). First-verse text must match so a borrowed tune cannot donate another hymn; own `tune.abc` only; PD only; new verses keep the seed chart's chords and key. After a write: `node tools/generate.mjs <pkg>` then `node tools/build-catalog.mjs` && `node tools/validate.mjs`. `--dry-run`, `--only slug` |
| `backfill-verses.ts` | Retired seed-data overlay. Use `backfill-library-chords.py --expand` |
| `backfill-coverage.py` | MusicXML harmony → ChordPro + MIDI + karaoke; `--partial` copies verse-1 chords onto later verses (reflows syllable-broken lines) |
| `scan-coverage.mjs` | Catalog report: chords / partial chords / MIDI / karaoke / PDF gaps |
| `audit-catalog.mjs` | Per-package catalog audit: verses vs ABC, ChordPro structure, MIDI vs key/BPM/meter/duration, related scripture, YouTube, lyric chrome, labels. Writes `sources/analytics.json`. `--start-here`, `--english`, `--only slug`, `--tasks verses,chordpro,midi,scripture,youtube,lyrics,labels`, `--dry-run`, `--apply`, `--relabel`. Labels/scripture-judge need sibling `jev-trial` + `AI_GATEWAY_API_KEY`. After `--apply`: `node tools/generate.mjs` then `build-catalog.mjs` && `validate.mjs` |
| `audit-midi.py` | MIDI meta (BPM, key signature, time signature, length) for `audit-catalog.mjs` |
| `generate-lyric-timings.py` | Karaoke word timings from ABC + MIDI (hymns; clocks the synthesized tune) |
| `align-vocal-timings.py` | Karaoke word timings from a writer MP3 via faster-whisper (clocks the recording) |
| `trim-midi-tails.py` | MIDI cleanup |
| `sync-cover-art.ts` | Matched loose cover-art files to songs by title (obsolete: drop `cover.webp` into `masters/`) |

Python tools that read MIDI need `mido` and `music21`. ABC conversion uses the vendored `tools/vendor/abc2xml.py`.
