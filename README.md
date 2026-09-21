# WorshipCommons Content Library

The songs behind [worshipcommons.org](https://worshipcommons.org). Each song is a folder of files. Everything here is freely usable under the license on that song — see [LICENSE.md](LICENSE.md).

---

## The 30-second version

One file and two folders:

| Path | Meaning | Who may edit it |
|---|---|---|
| `song.json` | Identity, rights, form map. Nothing rebuilds it | A person, on purpose |
| `sources/` | Bytes this package cannot reproduce from its own other files | Acquired bytes never; files we authored, on purpose |
| `output/` | Anything `generate.mjs` or `pack/build.py` rebuilds on any machine | Nobody. Rebuild it |

**The test: delete the file — can a tool in this repo rebuild it byte-for-byte?**
Yes -> `output/`. No -> `sources/`. That is why the words, the covers and the lyric timings are
sources even though we produced some of them: nothing in here regenerates them.

**If a chart is wrong, fix the source (or the generator). Never patch the output.** `output/` is
gitignored in full, with no exceptions — that is only safe because nothing unrebuildable lives there.

`catalog.json` is the index of the library. It is generated from the folders and must match a fresh build.

---

## What’s in this repo

```
songs/<lang>/<slug>-<id>/      one package per song
  song.json                    identity, rights, form
  sources/                     manifest.json + every byte we cannot rebuild
    grants/                    the paper: signed grant, email, form receipt
    master/                    a granted recording, when we have one
    extra/                     granted but not processed (tabs, orchestra parts)
  output/
    composition/               charts, slides, score, slides.json, LICENSE.txt
    audio/                     pack zip + full mix + 30 s preview + instrumental — only with a master grant
writers/<slug>/                portraits and bios, shared across songs
licenses/                      full text of each song license
sources.json                   where content came from, and any attribution we owe
themes.json                    allowed theme tags
catalog.json                   generated index of the whole library
tools/                         Node scripts (no npm install); tools/pack/ is python
```

Example: [Amazing Grace](songs/en/amazing-grace-YxPfAFYWOaG/) lives at

```
songs/en/amazing-grace-YxPfAFYWOaG/
```

- `en` is the language folder (`English` -> `en`).
- `amazing-grace` is a cosmetic slug from the title. Changing the title does **not** rename the folder.
- `YxPfAFYWOaG` is the frozen song id (always the last 11 characters of the folder name; ids can start with `-` or `_`, so do not split on the dash).

**The license is not in the path.** It is mutable — a writer relicenses, a PD claim gets corrected —
and this path is the bucket key and the asset URL. The license lives in `song.json` and the catalog.

---

## How a song is built: sources -> output

```mermaid
flowchart LR
  subgraph src["sources/ — what we cannot rebuild"]
    words["lyrics.chordpro<br/>the words"]
    abc["tune.abc<br/>written hymn score"]
    sheet["sheetPdf.pdf<br/>printed sheet music"]
    pic["cover.webp<br/>cover art"]
    rec["master/song.wav<br/>a granted recording"]
    grant["grants/…<br/>the paper"]
  end

  meta["song.json<br/>title, rights, form"]

  subgraph comp["output/composition/"]
    dscore["score.musicxml<br/>from tune.abc"]
    dpdf["chart.pdf<br/>printable chart"]
    dcho["chart.chordpro"]
    dslides["slides.json"]
    dlic["LICENSE.txt<br/>what was granted"]
  end

  subgraph audio["output/audio/"]
    dstems["pack zip, full mix,<br/>preview"]
  end

  abc --> dscore
  sheet --> dscore
  rec --> dscore
  words --> dscore
  words --> dcho
  words --> dpdf
  words --> dslides
  meta --> dlic
  grant --> dlic
  rec --> dstems
  pic --> dstems
```

A song with `song.json` + `sources/lyrics.chordpro` is complete and valid. We do not invent a
melody without a recording or a written score. A granted mix in `sources/master/` always
runs `python tools/pack/build.py`: a stems pack of the instruments that are in the mix
(vocal + guitar stays vocal + guitar), then a multi-instrument MIDI from the stems and
melody MusicXML with the ChordPro words underlaid. MIDI preserves detected performance
timing; notation uses the tracked beat grid. That generated score is a sketch until a
person promotes it to `sources/score.musicxml`. See the [audio-to-MIDI runbook](tools/pack/MIDI.md)
for reproduction commands, repeated-note handling, and validation against the stems.

### `sources/` — what we cannot rebuild

Two kinds of file live here, and `manifest.json` tells them apart. A file with no manifest row
does not exist as far as the tools are concerned.

| Kind | `original` | Rule |
|---|---|---|
| Acquired — a MIDI, an ABC file, a hymnal scan, a granted recording | `true` | Frozen. Keep the bytes as fetched; the sha256 must match forever. If it is wrong, add a new file and a new row |
| Ours — the words we typed, a cover we generated once, lyric timings | `false` | Editable on purpose; git history is the log. Re-run `writeManifest` so the sha stays true |

| File | What it is |
|---|---|
| `lyrics.chordpro` | The **words**. Always present. Nothing in this repo rebuilds them |
| `tune.abc` | Open Hymnal SATB score (often on the **work**, shared by translations) |
| `tune.mid` | Cyber Hymnal / HymnSite MIDI (pitch sketch, not a distributed score) |
| `score.musicxml` | The notes, when someone gave them to us. Optional — `output/` holds the ABC conversion instead |
| `sheetPdf.pdf`, `*.ly` | Scanned or engraved sheet, plus LilyPond source when we have it |
| `cover.webp` | The package image. Generated once; kept, never regenerated |
| `timing.json` | Lyric timings for karaoke. Hymns: `tools/harvest/generate-lyric-timings.py` (ABC+MIDI). Writer recordings: `tools/harvest/align-vocal-timings.py` (MP3 vocal) |
| `master/<name>.wav` | A granted master recording. One per song. A YouTube id is a link, not a master |
| `grants/<date>-<who>.<ext>` | The grant itself — what a manifest row's `evidence` points at |
| `hymnary.json` | Harvested hymnal counts — used at catalog build, not copied into `song.json` |
| `video.json` | A YouTube id. A link, not our recording |
| `analytics.json` | Catalog audit notes (verse gaps, MIDI drift, label confidence, extra scripture). Not public catalog fields |
| `manifest.json` | One row per file in this folder, subfolders included |

Harvested facts stay here. Do not paste hymnal counts or YouTube ids into `song.json`.

**Grants.** A song has two independent rights layers: the composition (words, melody, chords —
**required**, no grant no song) and the master recording (optional — it unlocks multitracks).
`song.json` `rights.<layer>` says what license each layer carries; the manifest row for each
file says who granted it, when, how, and where the paper is:

```json
{
  "file": "master/song.wav",
  "layer": "recording",
  "license": "WC",
  "licenseVersion": "1.0",
  "submittedBy": "Jane Doe",
  "acquired": "2026-09-12",
  "obtainedVia": "upload-form",
  "evidence": "grants/2026-09-12-jane-doe.pdf",
  "sha256": "..."
}
```

`layer` is one of `text` `tune` `arrangement` `recording` `artwork` `extra` `grant`.
`obtainedVia` is one of `upload-form` `email` `harvest` (needs a `url`) `transcription`
`public-domain` `generated`. `validate.mjs` enforces all of it, and refuses a master recording
whose grant is not on file. The whole flow is [.notes/song-pipeline.md](../../agents/WC/song-pipeline.md).

### `song.json` — what a person asserted

Title, writer, year, key, themes, scripture, license, per-layer `rights`, `form` map. The only
file at the package root, because it is the only thing that is neither given to us nor generated.

- `rights` — text, tune, arrangement, recording and artwork each have their own license row. A hymn is not one blob. `"Amazing Grace"` words + tune can be public domain while a 2008 reharmonization is not.
- `form` — verse/chorus map and default singing order. Drafted by tools (`status: "draft"`) until a reviewer sets `"approved"`.
- `parent` — `{ "id": "<song id>" }` on a translation: the song it inherits from (see Translations).

### `output/` — the machine wrote this

Rebuilt from scratch by `node tools/generate.mjs` and `python tools/pack/build.py`. Entirely
gitignored. Delete the folder and you lose nothing.

| File | From |
|---|---|
| `composition/score.musicxml` | `sources/tune.abc`, via the vendored abc2xml. A score in `sources/` wins and this one is removed |
| `composition/chart.chordpro` | Copy of the lyrics, until a score-driven chart generator exists |
| `composition/score.mid` | A copy of `sources/tune.mid` when the package has one. Otherwise music21 plays the score. A stem-sketch MIDI is left alone when the package has neither `tune.mid` nor `tune.abc` |
| `composition/chart.pdf` | Chord chart in the original key, when the text encodes as WinAnsi. Other keys are transposed on demand. Non-Latin text is skipped |
| `composition/slides.json` | Projection slides from the lyric sections |
| `composition/duration.json` | Sing time. A leftover `output/composition/timing.json` wins; otherwise the master via ffprobe; otherwise lines × beats at the song's bpm. `sources/timing.json` is not read |
| `composition/attribution.txt` | Pasteable credit line |
| `composition/sources.txt` | Human-readable provenance |
| `composition/LICENSE.txt` | What was granted, by whom, what a church may do. Travels inside every bundle |
| `composition/cover-thumb.webp` | Thumbnail of this package's `sources/cover.webp`. No cover in this folder means no thumbnail |
| `audio/<pack>.zip`, `-fullmix.m4a`, `-preview.m4a`, `instrumental.m4a`, and `audio.zip` | From a granted master, after `generate.mjs` has written `LICENSE.txt`. `instrumental.m4a` appears when a vocal stem was separated. See [tools/pack/README.md](tools/pack/README.md) |

`stage.pdf`, engraved part PDFs, and `piano.mp3` / `organ.mp3` / `click.mp3` are `node tools/generate-kit.mjs`, not this rebuild. See Tools.

**One owner per kind of fact.** The words are either `sources/lyrics.chordpro` or
`output/composition/lyrics.chordpro`, never both — `validate` errors if two files claim the same
fact, because one of them is silently stale. Same for `score.musicxml`. The source always wins.

---

## `catalog.json`

```
node tools/build-catalog.mjs
```

Commit it in the **same commit** as the content that changed. Paths in the catalog are repo-relative (`songs/en/amazing-grace-YxPfAFYWOaG/…`) and the content bucket mirrors them, so a path change means a bucket re-sync and an asset re-seed.

---

## Changing curated content

1. Edit the package.
   - Facts a person is asserting → `song.json`
   - Lyrics / chords → `sources/lyrics.chordpro`
   - Harvested facts, granted files, the paper → `sources/`
   - Do not edit `output/`
2. Rebuild, reindex, check:

   ```
   node tools/generate.mjs songs/en/amazing-grace-YxPfAFYWOaG
   node tools/build-catalog.mjs
   node tools/validate.mjs
   ```

   `generate.mjs` also accepts a slug (`amazing-grace`), a language folder (`songs/en`), or no argument (whole library).
3. Commit the package **and** the regenerated `catalog.json` together. The commit message is the change note.

### Adding a new song

1. Create `songs/<lang>/<slug>/` with `song.json` and `sources/` (at least `lyrics.chordpro` and `manifest.json`). Leave `id` out of `song.json`.
2. Run `node tools/validate.mjs` — it will print the id to stamp.
3. Rename the folder to `<slug>-<id>` so the last 11 characters match. `validate` errors if they disagree.
4. Generate, build-catalog, validate, commit.

Required in `song.json` for a catalog song: `id`, `title`, `writer`, `language`, `license`, `timeSignature`, `rights`. Themes must be names from `themes.json`. The license must be an id in `licenses/licenses.json` (the six featured grants, or a custom writer grant).

---

## Translations

A translation is a **separate song** that names the song it came from:

```json
"parent": { "id": "DdnkGm4QMhD" },
"relationLabel": "Spanish translation · tr. Federico Fliedner, 1871"
```

The parent is the base version — the original language when we have it — and owns the shared
musical assets. A translation's `song.json` holds only what differs: its title, writer/translator
credit, year, language, scripture reference, rights, status, and its own `sources/lyrics.chordpro`
and `timing.json`. Anything it leaves out it inherits from the parent:

| Inherited unless the translation has its own | Never inherited |
|---|---|
| `key`, `bpm`, `timeSignature`, `meter`, `tune`, `themes`, `writerRef` (`INHERITED_FIELDS` in `tools/lib.mjs`) | the words, `timing.json`, translator credit, rights, status |
| `sources/tune.abc`, `sources/tune.mid`, `sources/cover.webp` | `output/composition.zip` |
| `sources/master/` and everything `pack/build.py` built from it (`output/audio/`, `audio.zip`) | — |

The generators open only the package they were given. A translation's rebuild writes its chart,
slides, and license from its own words. It does not open the parent's `tune.abc`, `tune.mid`, or
`cover.webp`, so it does not write a `score.musicxml`, a cover thumbnail, or a piano/organ render
for those files. `build-catalog.mjs` points `abcUrl`, `midiUrl`, and `artUrl` at the parent and
counts the parent's tune as this song's score.

The recording is processed **once, at the parent**. The catalog row points at the parent's stems
pack, preview, full mix, and instrumental bed. The vocal on that recording is in the parent's
language, and the site says so. A translation that cannot use a parent asset (different verse
order, say) opts out with `"noInherit": ["output/audio"]`; a translation with its own
`sources/master/` gets its own pack and stops inheriting the parent's.

Families are flat: a parent is never itself a translation. Two translations in the same language
are fine — each has its own id and folder. If a translation's copy of a shared file is byte-identical
to the parent's, `validate` errors; if an inherited field equals the parent's, it warns. Delete the
copy so it inherits.

**First translation of a song:** add the `parent` line to the new song's `song.json`. Nothing moves.

---

## Tools

Run from the repo root. Run `validate` before every commit. There is no `requirements.txt`.

| Command | What it does | Installed software |
|---|---|---|
| `node tools/validate.mjs` | Schema and consistency checks. Exit 1 on errors | Node.js 18 or newer. No `npm install` in this repo |
| `node tools/generate.mjs [folder]` | Rebuild `output/composition/` for one package, a language folder, a slug, or the whole library | Node.js 18+. Python 3 on PATH (`python`, or `PYTHON=`) for ABC → MusicXML; the step is skipped with a warning when Python is missing. The converter is vendored at `tools/vendor/abc2xml.py`. `pip install music21` to write `score.mid` when the package has no `sources/tune.mid`. `ffprobe` on PATH to take a length from `sources/master/` |
| `node tools/generate-scores.mjs [folder]` | Score step only: `output/composition/score.musicxml` from this package's `sources/tune.abc` | Same Python and vendored abc2xml as `generate.mjs` |
| `node tools/build-catalog.mjs` | Regenerate `catalog.json` from the folders. Follows a translation's `parent` link | Node.js 18+ |
| `node tools/find-duplicates.mjs` | Report the same hymn under variant titles (`--apply` links them) | Node.js 18+ |
| `python tools/pack/build.py [folder]` | Multitracks for every package with one granted file in `sources/master/`. Run `generate.mjs` first; the pack stops without `output/composition/LICENSE.txt`. Idempotent | Python 3.13, ffmpeg and ffprobe, CUDA PyTorch, `audio-separator`, `music21`, `pillow`, `soundfile`, `scipy`, `numpy`. Transcription also needs `librosa`, `pretty_midi`, `basic-pitch`, `mir_eval`, and an ONNX runtime. Section callouts use Windows SAPI. `lead-sheet.pdf` is written when MuseScore 3 or 4 is on PATH (`MuseScore4`, `mscore`, or `C:\Program Files\MuseScore 4\bin\MuseScore4.exe`). Full list and the fresh-machine caveat: [tools/pack/README.md](tools/pack/README.md#requirements) and [tools/pack/MIDI.md](tools/pack/MIDI.md#environment-and-normal-rebuild) |
| `node tools/generate-kit.mjs [slug]` | Optional. `stage.pdf`, engraved `satb.pdf` / part PDFs / `lead.pdf`, and `piano.mp3` / `organ.mp3` / `click.mp3`, plus a 12-key pad set in `assets/pads/`. Runs `generate.mjs` first, then may rewrite `sources/lyrics.chordpro` with chord backfill. Reads only this package's `tune.abc` and `tune.mid` | Node.js 18+. A sibling `WorshipCommons` checkout with its dependencies installed (`abcjs` and Playwright for engraving, `public/soundfonts` for piano and organ). ffmpeg for the mp3s. Flags: `--skip-audio`, `--skip-engrave`, `--skip-chords`, `--skip-lead-abc`, `--skip-pads`, `--skip-base` |

One-shot migrations (safe to re-run; they no-op when already done):

| Command | What it did |
|---|---|
| `node tools/migrate-layout.mjs` | Dropped the license folder level and split each package into `song.json` / `sources/` / `output/` |

Importers that built this library live in `tools/harvest/`. They are not needed to consume or edit it. See [tools/harvest/README.md](tools/harvest/README.md).

---

## Licenses

One license per song, named in `song.json` — not in the path, because a license can change and the path is the bucket key. We do not host no-derivatives (ND) licenses: transposing, arranging, and translating are the point.

| `song.json` `license` | In short |
|---|---|
| `PD` | Public domain / CC0 |
| `WC` | WorshipCommons License — free for worship; commercial rights stay with the writer |
| `CC-BY` | Credit required |
| `CC-BY-SA` | Credit required; derivatives share alike |
| `CC-BY-NC` | Credit required; no commercial use |
| `CC-BY-NC-SA` | Both of the above |

Individual layers can differ from the song's headline license — `song.json` `rights.<layer>` is the detail. Full terms: [LICENSE.md](LICENSE.md) and `licenses/`. Per-song provenance is in `sources/manifest.json` and the generated `output/composition/sources.txt`.

---

## Languages

`song.json` `"language"` is the English name; the folder is the code.

| Language | Folder |
|---|---|
| English | `en` |
| Malayalam | `ml` |
| Spanish | `es` |
| French | `fr` |
| Hungarian | `hu` |
| German | `de` |
| Portuguese | `pt` |
| Russian | `ru` |
| Albanian | `sq` |
| Latin | `la` |
| Swedish | `sv` |
| Zulu | `zu` |

---

## Writers

`writers/<slug>/` holds a portrait and a short bio, shared by every song that sets `writerRef`. Portraits are Wikimedia-verified public domain / CC0. Bios are Wikipedia openings, CC BY-SA. See [writers/LICENSE.md](writers/LICENSE.md).

Living writers may also set `supportLinks` and `links` (`{ "label", "url" }`). Catalog seed copies those onto the author row, so “Support the writer” survives `reset-commons` and `commons-sync-catalog`. Match is the writer credit: folder slug, `name`, or a person named in a composite credit (`Larry Holder / Elton Smith`).
