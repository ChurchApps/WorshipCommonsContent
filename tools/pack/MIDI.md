# Reproducing and checking audio-to-MIDI conversion

Run commands from the `WorshipCommonsContent` repository root. The worked example is
`for-the-wonder-of-gods-love-_6zv6iZLTT1`; change `$songSlug` for another song and
use that package's actual master filename and vocal stem filename.

## Scope: recording transcription versus authored scores

This runbook primarily covers audio-to-MIDI transcription. For MIDI generated from
an authored MusicXML or ABC score, preserve the written notes, voices, rhythms,
repeats, and tempo changes. Do not apply audio-detector thresholds, vocal-range
filters, or a recording-duration limit to that score unless it is explicitly being
adapted to a recording. Acquired `sources/tune.mid` files remain unchanged.

## Conversion path and timing rules

`sources/master/song.mp3` → `separate_stems.py` →
`tools/.cache/pack/<song>/stems_out/` → `stems_to_score.py` →
`output/composition/score.mid`, `score.musicxml`, and a rendered lead sheet when available.

The separator uses MelBand Roformer for vocals and BS-Roformer SW for band instruments.
Basic Pitch transcribes polyphonic pitched stems. Bass uses monophonic pyin;
pyin also supplies the separate MusicXML melody. Drums use onset detection and band energy.
If Basic Pitch is unavailable, transcription falls back to pyin, which cannot preserve
piano/guitar chords. Check the environment before comparing transcription quality.

Preserve these rules when changing the implementation:

- MIDI retains detected note starts and durations in recording time. Only notation
  snaps to the tracked beat grid. Avoid independently rounding MIDI starts and lengths.
- `playable_notes()` resolves same-pitch overlaps at the writer's tick resolution
  before serialization. Coincident detections coalesce; a new attack ends the previous
  note on that key. Different pitches remain polyphonic. The writer uses 960 ticks/beat.
- `frames_to_notes()` filters runs shorter than the minimum duration instead of
  lengthening pitch glitches into notes. It includes the last frame's duration.
- Notes before the first detected beat retain their pickup position in notation;
  they must not all collapse onto that beat.
- Keep the recording's intro, silence gates, velocities, and cross-stem duplicate
  filtering. Decode compressed inputs into unique temporary files so concurrent
  checks do not overwrite or delete one another's audio.

`tools/generate/score.mjs` preserves the stem MIDI when there is no human score or
ABC source. Converting the generated melody MusicXML back to MIDI would lose band parts
and performance timing. `sources/tune.mid` remains the acquired source file, and when
it exists it is what ships as `output/composition/score.mid` (both `generate.mjs` and
`build.py` copy it over any generated MIDI). The stem sketch still writes the notation.

## Safeguards for every recording transcription

Use these as generation and review requirements. The current implementation does
not yet enforce all of them; the gaps below need checking when reviewing a candidate.

- Bound detected note starts and ends to the decoded source recording's duration.
  Separator padding is not evidence of additional music. Preserve the recording's
  actual intro, rests, and audible ending.
- Allow simultaneous drum classes: a kick and hi-hat at the same instant are two
  events. Do not force each broadband onset to choose exactly one drum sound.
- Use one identified lead-melody estimate for both the lead MIDI track and notation.
  Notation may quantize that estimate; it should not independently guess different
  pitches. Keep backing voices separate where they can be identified.
- Preserve reference provenance. Align shared sections, key/register, and timing
  before comparison; different arrangements can have different form and instruments.
  Keep score key, recording key, and section-level key changes distinct. A global
  detected key must not silently overwrite curated metadata or transpose every asset.
- Validate musical content as well as serialization: missing/extra notes, octave
  errors, false repeated attacks, voice separation, concurrent drums, and the ending.
  Zero overlaps or a successful `--check` exit is not sufficient evidence of quality.

Known gaps from the [All Of My Heart review](reviews/all-of-my-heart.md): the vocal
MIDI uses polyphonic Basic Pitch while notation uses a separate pyin estimate;
drum classification chooses one sound per onset; separator tails can produce notes
beyond the master. Treat these as implementation work still to do, not features
enabled by following this document. Adaptive vocal range is also not implemented.

## Settings and decisions that depend on the recording

| Decision | Guidance |
|---|---|
| Vocal pitch range | Estimate or configure it from the actual singer and check low/high phrases. Neither C3 nor the G2 trial below is a universal lower bound. Avoid mistaking harmonics for the lead. |
| Monophonic lead | Appropriate for an identified solo lead. Choirs, backing vocals, and instrumental chords need separate voices or polyphonic tracks; do not flatten the whole stem. |
| Same-pitch fragments | Join only when voicing and onset evidence support a sustained note. Preserve repeated syllables, deliberate reattacks, and instrumental repetitions. Overlap cleanup alone cannot distinguish these cases. |
| Voicing/confidence thresholds | Balance missed notes against bleed/noise for the source and model. Keep silence/voicing checks; lowering a threshold on one passage does not justify a global change. |
| Tempo and key | Check changes by section. Preserve performance timing in MIDI and use the tracked grid for notation; a single song-wide estimate can conceal modulation or tempo drift. |

In the aligned first verse of All Of My Heart, a G2-floor pyin trial using its
voiced/unvoiced flag without our additional 0.5 probability cutoff produced 52
attacks against 55 in the reference, versus 99 in the generated MIDI. Pitch-time
F1 rose from 72.2% to 75.7%. Lowering Basic Pitch's range alone barely improved F1
and added detections. These are exploratory results from one fitted passage,
not a new default, a note-onset accuracy score, or a universal target note count.

Before adopting detector defaults, compare saved baselines and candidates across
low and high solo voices, backing vocals/choirs, sparse accompaniment, and full
bands. Include sustained vowels, repeated syllables, quiet passages, harmonized
choruses, and endings. Record the model/runtime, settings, source hashes, alignment,
and measurement windows. Use passages beyond those used to tune the settings and
include listening; investigate regressions before applying a setting library-wide.

## Environment and normal rebuild

Use the [pack requirements](README.md#requirements). Transcription also needs
`librosa`, `pretty_midi`, `basic_pitch`, `mir_eval`, and a working Basic Pitch model
runtime (ONNX in the tested environment). Existing Python 3.13 setup used
`pip install --no-deps basic-pitch mir_eval` to avoid incompatible dependency pins;
that command alone does not provision all dependencies on a fresh machine.

```powershell
$songSlug = 'for-the-wonder-of-gods-love-_6zv6iZLTT1'
$songPkg = "songs/en/$songSlug"
$stemsDir = "tools/.cache/pack/$songSlug/stems_out"

python -c "import librosa, pretty_midi, soundfile, music21; from basic_pitch import ICASSP_2022_MODEL_PATH; from basic_pitch.inference import Model; print(Model(ICASSP_2022_MODEL_PATH))"
python tools/pack/test_stems_to_score.py
node tools/generate.mjs $songPkg
python tools/pack/build.py $songPkg
```

Verified 2026-09-15: the normal build and the direct `stems_to_score.py` command produce
note-for-note identical `score.mid` (three consecutive `build.py` runs, one with `song.json`
`key` nulled first). Two `build.py` fixes came out of that run: its progress line used a
Unicode arrow and crashed under a non-UTF-8 stdout (any piped or scheduled run), and it copied
`song.json` into the work folder *before* stamping the detected key, so a song with a null key
packed as `-C-` on its first build and `-E--` on the next. The stamped file is now re-copied.

The normal build checks master grant metadata, reuses fresh cached stems, transcribes
when there is no `sources/score.musicxml`, and rebuilds the audio pack. `-f` forces a
pack rebuild but still reuses fresh stems. Changing transcription code invalidates
the pack's freshness check, but the sketch has its own reuse check. Use `-f` or the
direct candidate command below when testing transcription-code changes so an old
sketch is not mistaken for a new result. A timing-only fix does not require
separating the audio again.

## Diagnose and regenerate from cached stems

Use this workflow to preserve an existing MIDI for comparison and generate a candidate
without rebuilding the pack. If stems are missing, run the normal build first.
The direct transcription command does not perform the build's grant checks or human-score
precedence checks; use it on the already established recording-derived score workflow.

```powershell
# Reuse the variables above. Timestamp keeps each investigation separate.
$reviewDir = "tools/.cache/midi-review/$songSlug/$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $reviewDir | Out-Null
Copy-Item -LiteralPath "$songPkg/output/composition/score.mid" -Destination "$reviewDir/before.mid"
python --version | Out-File "$reviewDir/python-version.txt"
python -m pip freeze | Out-File "$reviewDir/python-packages.txt"
git rev-parse HEAD | Out-File "$reviewDir/revision.txt"
git diff --output="$reviewDir/working-tree.patch" -- tools/pack

python tools/pack/stems_to_score.py --check "$reviewDir/before.mid" $stemsDir --seconds 8
if ($LASTEXITCODE -ne 0) { throw 'Baseline check failed' }

python tools/pack/stems_to_score.py "$stemsDir/song_vocals.m4a" "$songPkg/sources/lyrics.chordpro" "$reviewDir/candidate" --stems-dir $stemsDir --mix "$songPkg/sources/master/song.mp3"
if ($LASTEXITCODE -ne 0) { throw 'Transcription failed' }

python tools/pack/stems_to_score.py --check "$reviewDir/candidate/score.mid" $stemsDir --seconds 8
if ($LASTEXITCODE -ne 0) { throw 'Opening check failed' }
python tools/pack/stems_to_score.py --check "$reviewDir/candidate/score.mid" $stemsDir
if ($LASTEXITCODE -ne 0) { throw 'Full-song check failed' }
```

Save the printed reports alongside the candidate. `--check` reports measurements;
its successful exit does **not** mean that the transcription passed quality thresholds.
The mix supplies tempo detection; do not hardcode this example's 136 BPM for other songs.

After reviewing the candidate, install the related composition outputs together:

```powershell
Copy-Item -LiteralPath "$reviewDir/candidate/score.mid","$reviewDir/candidate/score.musicxml" -Destination "$songPkg/output/composition"
foreach ($sheetName in @('lead-sheet.pdf')) {
    if (Test-Path -LiteralPath "$reviewDir/candidate/$sheetName") {
        Copy-Item -LiteralPath "$reviewDir/candidate/$sheetName" -Destination "$songPkg/output/composition"
    }
}
```

This installs composition outputs locally. Use the normal pack build when a refreshed
download bundle is also needed. Both `output/` and `tools/.cache/` are ignored by git;
commit the implementation, tests, and documentation to retain the reproducible process.

## Validation and listening

When a writer-supplied MIDI exists, compare shared passages after aligning the
arrangement, tempo, and vocal register. It is a separate arrangement, not automatically
a note-for-note target for the recording. See the measured
[All Of My Heart comparison](reviews/all-of-my-heart.md) for vocal-range exclusion,
false repeated attacks, concurrent drums, separator padding, and a controlled
lead-detector experiment. Passing overlap/chroma checks alone missed these issues.

Inspect the opening, a representative verse/chorus, and the ending separately from
the whole song; an average can hide a broken passage. In addition to `--check`:

- Compare master/stem duration and alignment. Check for any note starting after
  the master ends or sustaining into separator padding.
- Inspect the lead's register, missing low/high notes, simultaneous pitches, and
  sustained-note fragmentation. Determine whether extra voices are real harmonies
  before removing them. Compare lead MIDI pitches with the generated notation.
- Inspect coincident drum hits against the drum stem. A sparse snare track or no
  simultaneous hits merits investigation, not copying counts from another arrangement.
- For a reference comparison, report the aligned section and transposition/time
  mapping. Freeze that mapping when comparing detector candidates. Report pitch
  precision/recall separately from onset and duration metrics; whole-file note counts
  and chroma alone do not establish transcription accuracy.

These additional checks are not all automated by the current `--check` command.
For each generated track, expect `same_pitch_overlaps=0`. Investigate
`notes_under_30ms` rather than treating zero as a universal musical requirement.
Compare onset F1 and chroma with the same stems, window, and tool version. Chroma
ignores octave errors and does not establish correct rhythm, articulation, or timbre.
The register estimate is useful for monophonic stems, not piano chords or residual pads.

For an audible comparison, import the stems and both MIDI files into a DAW at time zero.
Use the same instruments and gains for both MIDI versions, disable import quantization
and audio warping, and keep the MIDI tempo when importing. Solo the piano first,
then inspect each track and the ensemble. Check repeated attacks around 4.24 seconds
in this example. A piano-sample render of every pitched track is useful for comparing
timing, but does not reproduce the original instruments.

## Recorded regression: For the Wonder of God's Love

The original independent start/duration quantization produced overlapping repetitions.
Near 4.24 seconds, earlier note-offs cut several new piano notes to approximately 6 ms.
These measurements compare the saved original file with the corrected full regeneration:

| Measurement | Before | After |
|---|---:|---:|
| Full-song same-pitch overlaps, summed across tracks | 202 | 0 |
| Full-song notes shorter than 30 ms | 47 | 0 |
| First 8 seconds: piano same-pitch overlaps | 10 | 0 |
| First 8 seconds: piano notes shorter than 30 ms | 5 | 0 |
| First 8 seconds: piano onset F1, 70 ms tolerance | 0.77 | 0.85 |
| First 8 seconds: piano chroma similarity | 0.91 | 0.93 |

The 23-test suite passed, including MIDI write/read regression coverage for premature
note-offs, repeated attacks, coincident detections, pickup notes, and pitch-glitch filtering.
These values describe this recording and saved baseline, not required scores for future songs.
Rerunning corrected code will not recreate the defective baseline; preserve the original
MIDI before a future change. Dependency/model changes can also change transcription results.

The original investigation's local artifacts are in `tools/.cache/midi-investigation/`:
`before.mid`, `regenerated/score.mid`, `validation.json`, and `compare.html` with
`stems.wav`, `before.wav`, and `after.wav`. The comparison uses the first eight seconds,
identical piano samples for all pitched MIDI tracks, a shared MIDI gain, and a separately
normalized piano-plus-other stem mix. These are disposable cache artifacts, not fixtures
required by the workflow above. The investigation used signal analysis, not direct listening.

Remaining limitations include separator bleed and ghost notes in `other`, approximate
instrument timbres, simplified drums, sustain/pedal inference, and a single MIDI tempo
rather than a performance tempo map. Removing overlap defects does not make the result
a proofread transcription.
