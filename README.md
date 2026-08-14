# WorshipCommons Content Library

The source-of-truth content for [worshipcommons.org](https://worshipcommons.org) —
an open library of worship music. Everything here is freely usable: see
[LICENSE.md](LICENSE.md) for the per-section terms.

## Layout

```
songs/<lang>/public-domain/<title>/   one folder per public-domain song
songs/<lang>/wc-license/<title>/      writer-shared songs (WorshipCommons License)
writers/<slug>/                       writer portraits + bios (shared across songs)
licenses/                             full text of each song license
sources.json                          where content came from + attribution obligations
catalog.json                          generated one-file form of the whole library
tools/                                zero-dependency Node scripts (build, validate)
```

Each song folder contains:

| File | What it is |
|---|---|
| `song.json` | Authoritative metadata: id, title, writer, year, key, themes, scripture, license, links, per-file provenance |
| `lyrics.chordpro` | Lyrics with inline chords (ChordPro), directive header + body |
| `tune.mid` | Melody MIDI (when a tune source exists) |
| `tune.abc` | ABC engraving source (Open Hymnal tunes) |
| `timing.json` | Word-level lyric timings for karaoke highlighting |
| `art.webp` | Cover art |
| `sources.txt` | Human-readable provenance/attribution (generated) |

Folder names are cosmetic title slugs (native script for non-Latin languages);
a song's identity is the `id` in its `song.json` — deterministic, frozen at
creation, and stable even if the title is edited.

## Tools

Plain Node ≥ 18, no dependencies:

```
node tools/validate.mjs           # schema/consistency checks — run before committing
node tools/write-sources-txt.mjs  # regenerate every sources.txt (the only writer of them)
node tools/build-catalog.mjs      # regenerate catalog.json from the folders
```

`catalog.json` is committed and must always match a fresh build. It is what the
WorshipCommons API vendors (as `config/catalog.json`) to seed its database;
its url columns are repo-relative paths (= bucket keys).

## The content bucket mirrors this repo

The live content bucket (content.worshipcommons.org) holds `songs/` and
`writers/` in **exactly this repo's layout** — the bucket is the operational
master, this repo is its periodic snapshot and disaster-recovery source.
User submissions on the site write new song folders straight into the bucket
(`song.json` has `submittedBy`/`status`/`uploads`; no provenance or sources.txt).

**Export bucket → repo** (run periodically, commit the diff):

```
aws s3 sync s3://<content-bucket>/songs songs --delete
aws s3 sync s3://<content-bucket>/writers writers --delete
node tools/write-sources-txt.mjs && node tools/build-catalog.mjs && node tools/validate.mjs
git diff   # eyeball, then commit content + regenerated catalog.json together
```

**Rebuild bucket ← repo** (disaster recovery):

```
aws s3 sync songs s3://<content-bucket>/songs
aws s3 sync writers s3://<content-bucket>/writers
```

then reseed the API database from `catalog.json` (see WorshipCommonsApi).
Song ids are frozen in each `song.json`, so votes/sings/libraries keyed on
song id survive any repopulation.

## Changing curated content

1. Edit the song folder (or add a new one — leave out `id` and `validate` will
   tell you the id to stamp).
2. `node tools/write-sources-txt.mjs && node tools/build-catalog.mjs && node tools/validate.mjs`
3. Commit content + regenerated `catalog.json` together.
4. Push to the bucket: `aws s3 sync songs s3://<content-bucket>/songs` (and
   `writers` if changed) — never `--delete` in this direction unless you mean it.

The site picks the change up via the API repo's `yarn sync-catalog` (see the
runbook in WorshipCommonsApi).
