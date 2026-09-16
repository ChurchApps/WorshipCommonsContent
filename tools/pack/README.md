# tools/pack — multitracks from a granted master recording

Builds the rehearsal bundle for songs whose `sources/master/` holds a recording someone
granted us: stems, a click + section-callout track, an Ableton Live pack, a full mix, a
preview, and a zip with `LICENSE.txt` inside.

**No master recording, no pack.** Every track in the zip came out of the recording.
A song without a master grant is still a complete song — it just has no pack.

**A granted mix always packs.** After `node tools/generate.mjs <pkg>`, run
`python tools/pack/build.py <pkg>`. That is the standard rebuild, not an optional extra.

After stem separation, if the package has no `sources/score.musicxml`, the mix is
transcribed to MIDI and MusicXML (`stems_to_score.py`): pitched stems (vocals, piano,
guitar, bass) plus a simple drum track, on the mix's beat grid, with the recording's
intro left in place. Words from `sources/lyrics.chordpro` are underlaid on the melody.
That generated score is a sketch (same class as a MIDI import). It lives in
`output/composition/` (`score.mid`, `score.musicxml`, `lead-sheet.pdf` when MuseScore or
Verovio is present). A person promoting it copies the MusicXML to `sources/score.musicxml`.
`sources/tune.mid` is never rewritten.

```powershell
python tools/pack/build.py                                    # whole library
python tools/pack/build.py songs/en                           # every English song
python tools/pack/build.py songs/en/<slug>-<id>               # one package
python tools/pack/build.py -n songs/en                        # what would build
python tools/pack/build.py -f <pkg>                           # rebuild anyway
```

Idempotent: a package whose `output/audio/*.zip` is newer than its master,
`song.json`, `manifest.json`, and these scripts is skipped. Run it nightly over the
whole library and it costs nothing when nothing changed.

`node tools/generate.mjs <pkg>` must run first — the pack copies that package's
`output/composition/LICENSE.txt` into the zip.

## The gate

`build.py` refuses (and says why) unless all of this is true:

- exactly one audio file in `sources/master/`
- `song.json` `rights.recording` is not null, and `bpm` is set
- the manifest row for that file has `license`, `evidence`, `submittedBy`, `acquired`
- the `evidence` file exists in `sources/`

## Steps

| Step | Tool | Notes |
|---|---|---|
| separate | `separate_stems.py` | MelBand Roformer → vocals; BS-Roformer SW → guitar, drums, bass, piano, other; then keep the instruments that are in the mix. A vocal + guitar recording packs as vocals + guitar, not a phantom band. 256k AAC. ~1 min for a 4-minute song on a 3060 |
| transcribe | `stems_to_score.py` | Mix stems → multi-instrument MIDI (pyin on pitched stems, onset drums) + melody MusicXML + lyrics underlay. Beat grid and tempo come from the mix. Skipped when `sources/score.musicxml` already exists |
| click | `make_bounce.py` | Click on every beat plus spoken two-bar section callouts. Section times come from the package's `score.musicxml` rehearsal marks; without a score it is click only. No song audio in this file |
| pack | `generate_multitracks.py --from-stems --real-only` | `Session.als`, `Stems/*.m4a`, `Full Mix.m4a`, `Album.jpg`, `-preview.m4a`, `-fullmix.m4a` — into the cache |
| zip | `build.py` | Adds `LICENSE.txt`, zips into `output/audio/`, moves the two mixes beside it |

Track map, only for stems that survived the presence check: Click Track ← bounce ·
Guide ← vocals · Drums · Bass · Piano ← same-named stem · Acoustic Guitar (no kit) or
EG 1 (kit present) ← guitar · Keys 1 ← other. Separator leftovers (bass/drums/piano
split off an acoustic guitar) are folded back into that guitar stem so the low end is
not thrown away. BGVS is a split of the vocal stem, not its own recording, so
`--real-only` leaves it out.

`Album.jpg` comes from `sources/cover.webp` when the package has one, otherwise a
generated title card.

## Audio format

`--format` picks what goes in `Stems/`: **`ogg`** (default, Vorbis q6 — native to Live and
about half the size of the AAC it replaced), `flac` (lossless, ~3x), `wav` (~4x), `m4a`
(320k AAC).

Live reads WAV, AIFF, FLAC and OGG natively; MP3 and M4A go through an external codec, and
[Ableton documents M4A as unreliable on Windows](https://help.ableton.com/hc/en-us/articles/211427589-Supported-Audio-File-Formats)
— a pack built as `m4a` opens in Live with the clips missing. That is why the default moved
to ogg. The full mix and preview beside the zip stay `.m4a`: they are for listening, not Live.

The session points at `Stems/<name>.<ext>` with `RelativePathType=1` — relative to the .als
itself, which is where `Stems/` sits. (`3` is relative to the *project* and depends on Live
honouring the `Ableton Project Info` folder; `1` has no such dependency.)

The zip holds the pack's **contents** at its root — `Session.als`, `Stems/`, `Album.jpg`,
`Full Mix.m4a`, `LICENSE.txt` — not a folder wrapping them, because every unzip tool already
makes one.

## Scores

The generator needs a timeline. If the package has a `score.musicxml` (in `sources/`, else
built into `output/composition/`) it is used
(and its rehearsal marks become click callouts and Ableton locators). If not, `build.py`
writes a placeholder score at the song's tempo and the mix's length: the pack still
builds, with no callouts and no locators.

## Requirements

Python 3.13, `ffmpeg`/`ffprobe` on PATH, CUDA PyTorch, `audio-separator`, `music21`,
`pillow`, `soundfile`, `scipy`, `numpy`. An RTX 3060 12 GB is enough. First run downloads
MelBand vocals (~913 MB) and BS-Roformer SW (~700 MB) into
`%USERPROFILE%\.cache\audio-separator-models`. Speech for the callouts is Windows SAPI.

`output/audio/` holds exactly three files: the pack `.zip`, `-fullmix.m4a` and
`-preview.m4a`. The extracted pack folder is an intermediate and never lands in the
package. `output/` is gitignored — bundles ship to the content bucket, not to git.

Scratch lives in `tools/.cache/pack/<package>/`, outside the package. After a successful
build only `stems_out/` survives there (the separated stems, the expensive part); the
extracted mix, soundfonts and WAV caches are deleted. Deleting the cache costs a
re-separation, nothing else.

Windows `MAX_PATH`: the pack folder name is long, so keep the repo somewhere short
(`D:\Code\WC\...` is fine) or enable long paths.

## Provenance of the vendored files

`separate_stems.py`, `make_bounce.py`, `mt_mix.py`, and `generate_multitracks.py` came
from the `opennetwork` spike (`D:\Temp\abc\opennetwork`), patched here for `MT_ROOT`
(run against one package's work dir) and `--real-only`.

`assets/session-skeleton.als.xml` is the Ableton Live 8.4.2 set skeleton the generator
rewrites per song; `assets/Ableton Project Info/Project8_1.cfg` is Ableton's own project
marker. Both were lifted from a commercial reference pack during the spike. That vendor's
branded icons (`MTicon.ico`/`.icns`) and the `Desktop.ini` pointing at them are **not**
shipped, and nothing we hand a church carries their name: the session is `Session.als` and
the audio folder is `Stems/`. Replacing the skeleton with one exported from our own Live
project would remove the last third-party bytes here.
