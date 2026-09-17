# All Of My Heart: reference MIDI comparison

Reviewed 2026-09-16. Package: `songs/en/all-of-my-heart-2FCCvjupEKe`.
This is a measured investigation, not a listening review or an approved transcription.

## Inputs and comparability

Downloaded [myheart.mid](https://songsofpraise.org/musicfiles/myheart.mid) again and
verified that it is byte-identical to `sources/tune.mid`:
`50936c34564c52adbf69078333794407df5ffa3023582508bb0fe4c88842c257`.
The generated `output/composition/score.mid` reviewed here has SHA-256
`b02ee8dbf71537f32fa2db77576d5595fa729b09a19ec6a96d0df80f3cc599ac`.

These are different arrangements. The reference lasts 240.15 seconds, starts at
101 BPM, and slows to 90 BPM at the end. The generated MIDI lasts 283.28 seconds
with a single 99 BPM tempo. Its source is `sources/master/song.mp3`, acquired from
`AllOfMyHeart2026.mp3`, which lasts 278.06 seconds. The cached vocal stem lasts
284.57 seconds. Summed stems correlate with the master at zero lag (normalized
waveform correlations 0.995, 0.990, 0.991 in 0–40, 100–140, 230–270 seconds).
The stems are aligned; their extra tail still needs to be bounded to the master.

The reference's key signature is A major. Fitting the shared first verse gives:

```
recording_seconds = reference_seconds * 1.009869 + 7.320257
recording_melody_pitch = reference_melody_pitch - 14 semitones
```

The opening melody is therefore an octave and a whole tone below the reference,
consistent with G rather than the package's A. Later audio windows shift their
pitch-class distribution upward by a semitone, suggesting a modulation; this
needs section-level verification. The generated MusicXML declares E-flat major.
Do not use one global key estimate to overwrite curated metadata or transpose
all assets: source score key, recording key, and later key changes are distinct.

## Findings

| Measurement | Reference | Generated |
|---|---:|---:|
| Instrument tracks | 10 | 5 |
| Lead/melody notes, entire file | 281 | 901 |
| Lead/melody range | B3–E5 | C3–B5 |
| Lead/melody median note length | 535 ms | 220 ms |
| Lead/melody sounding time with multiple pitches | 0% | 28.4% |
| Maximum simultaneous lead/melody pitches | 1 | 5 |
| Drum notes | 1,833 | 812 |
| Distinct drum pitches | 10 | 3 |
| Drum onset times containing multiple notes | 610 | 0 |

Whole-file note counts describe the artifacts, not accuracy: duration, form,
instrumentation, and backing vocals differ. The reference explicitly separates
lead, two harmony voices, and a soloist part. Our `Melody` is the polyphonic
transcription of the entire separated vocal stem. Multiple pitches can represent
real backing vocals, harmonics, or bleed; they are not all established errors.

1. **Vocal range is too restrictive for this performance.**
   `RANGE['vocals']` begins at C3. The transposed reference includes A2 and B2.
   A trial with a G2 lower bound recovers A2 around 24 seconds and B2 around
   32.65 seconds. Range should be estimated or configurable per recording.

2. **Sustained singing becomes false repeated attacks.**
   The reference's held E4 at 25.84–28.49 seconds maps to D3 around 33.4–36.1
   seconds. Our MIDI writes ten adjacent D3 notes from 33.399 to 36.211 seconds.
   Same-pitch overlap cleanup correctly makes these playable, but cannot tell a
   sustained vowel from ten intentional attacks. Use vocal onset/voicing evidence
   to join false splits; do not indiscriminately merge repetitions in every instrument.

3. **Melody MIDI and notation use different, conflicting estimates.**
   MIDI uses Basic Pitch; notation uses pyin with an additional 0.5 voiced-probability
   cutoff. A monophonic lead should be shared between notation and the lead MIDI
   track. Keep confidently detected harmony separately. Simply switching to the
   existing pyin configuration loses substantial melody coverage (see trial).

4. **Drum transcription structurally cannot describe the kit.**
   `transcribe_drums()` uses one `if/elif/else` choice at each broadband onset,
   emitting kick, snare, or closed hat. Here it produces 424 kicks, 376 hats, and
   only 12 snares. The reference demonstrates concurrent hits and additional kit
   sounds, but its exact counts are not targets for this recording. Detect/classify
   concurrent drum events independently and validate against the drum stem.

5. **There are notes in separator padding.**
   Four `Other` note-ons occur after the master ends; one Bass note lasts until
   283.28 seconds. Clip analysis to the decoded master length and check the ending
   as well as the opening. Do not infer music from separator output length alone.

6. **Existing checks are necessary but insufficient.**
   All generated tracks have zero same-pitch overlaps and zero notes below 30 ms.
   Those passing measurements coexist with the issues above. Chroma also ignores
   octave errors. Add lead pitch/range, sustained-note fragmentation, concurrent
   drums, source-duration, and section-level reference checks.

## Controlled first-verse experiment

Compared reference 11.881–47.525 seconds with the aligned recording window
(approximately 19.32–55.31 seconds). The reference has 55 note attacks there.
Fit time scale/offset and integer pitch shift on the baseline, then freeze them
for every candidate. Score pitch occupancy every 10 ms: precision is matching
pitch-time cells divided by predicted cells, recall by reference cells, and F1
their harmonic mean. This is **not** note-onset F1 or whole-song accuracy.
The arrangement/performance differs and the alignment was fitted on this passage;
the numbers are exploratory, not a held-out benchmark.

Trials transcribed the first 60 seconds of the same cached vocal stem. pyin used
the same 120 ms minimum note length and C6 upper limit. Trials are raw detector
outputs before notation quantization or production postprocessing.

| Detector/settings | Note attacks in window | Pitch-time precision | Recall | F1 |
|---|---:|---:|---:|---:|
| Existing generated MIDI | 99 | 77.7% | 67.5% | 72.2% |
| Basic Pitch, C3 floor, rerun | 99 | 77.7% | 67.6% | 72.3% |
| Basic Pitch, G2 floor | 114 | 72.8% | 72.0% | 72.4% |
| pyin, C3 floor, probability ≥ 0.5 | 36 | 88.5% | 35.5% | 50.7% |
| pyin, G2 floor, probability ≥ 0.5 | 39 | 84.5% | 36.1% | 50.6% |
| pyin, G2 floor, probability ≥ 0.1 | 47 | 83.6% | 60.3% | 70.1% |
| pyin, G2 floor, voiced flag only | 52 | 79.8% | 72.0% | 75.7% |

The last row still uses pyin's voiced/unvoiced decision; it removes only our extra
0.5 probability gate. This is a promising lead-extraction candidate, not evidence
to lower thresholds globally. Lowering Basic Pitch's range alone increases both
coverage and unwanted detections and barely changes F1. Validate on harmonized
choruses, quiet passages, repeated syllables, and other songs before adoption.

## Process changes to pursue

1. Preserve writer-supplied MIDI as a separate arrangement and regression reference.
   Align shared sections, tempo, and register before comparing. Do not force the
   recording sketch to reproduce instruments or form absent from its recording.
2. Establish one monophonic lead estimate with adaptive vocal range and calibrated
   voicing thresholds. Use the same estimate for lead MIDI and notation; retain
   separate harmony evidence. Validate sustained vowels and repeated syllables.
3. Allow concurrent drum classes. Add master-length clipping and explicit key,
   tempo-map, and detector/model provenance to generated-asset diagnostics.
4. Expand quality checks beyond chroma/overlaps. Use this song plus other distinct
   arrangements as regression cases, and include listening before publication.

No production generator, song metadata, or published asset was changed in this
investigation. The MIDI runbook links this review so future work can reuse it.

Local disposable artifacts: `tools/.cache/midi-review/all-of-my-heart-reference/`.
`analyze.py` writes `statistics.json`; `audio_check.py` writes `audio-check.json`;
`melody_check.py` writes `melody-check.json`; `experiments.py` writes
`experiments.json`. Run with `python -X utf8` from the repository root. The reference
download is `reference.mid`; the scripts require existing generated MIDI and stems.
Cache files are not versioned; hashes and measured results above identify this run.
