"""Pure-function checks for the recording-aligned MIDI sketch.

  python tools/pack/test_stems_to_score.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stems_to_score import drop_before, drop_doubles, drop_glides, find_stems, frames_to_notes, gate_quiet, playable_notes, quantize, transcribe_pitched, vocal_onset_time, write_midi


class PerformanceTiming(unittest.TestCase):
    def test_polyphonic_transcription_preserves_arpeggio_and_reattacks(self):
        from unittest.mock import patch

        raw = [(0.10, 0.68, 63, 86), (0.35, 0.61, 55, 79), (0.78, 0.24, 63, 97)]
        with patch('stems_to_score._basic_pitch_notes', return_value=raw):
            notes = transcribe_pitched(np.zeros(100), 22050, 'piano', 136, .162,
                                       np.array([.162, .627, 1.045]))
        self.assertEqual(notes, raw)

    def test_midi_roundtrip_has_no_premature_note_offs(self):
        import tempfile
        import pretty_midi

        # The intro's 4.24s reattack used to be cut off by the previous note
        # ending at 4.243s. Include coincident and nested duplicate detections.
        notes = [(3.802, .441, 63, 56), (4.237, .22, 63, 54),
                 (4.237, .30, 63, 80), (4.446, .22, 63, 58),
                 (4.237, .50, 67, 70)]
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / 'score.mid'
            count = write_midi({'piano': notes}, 136, path)
            result = pretty_midi.PrettyMIDI(str(path)).instruments[0].notes
        self.assertEqual(count, 4)
        self.assertEqual(len(result), 4)
        same_key = sorted((n for n in result if n.pitch == 63), key=lambda n: n.start)
        self.assertTrue(all(a.end <= b.start for a, b in zip(same_key, same_key[1:])))
        self.assertAlmostEqual(same_key[1].start, 4.237, delta=.001)
        self.assertAlmostEqual(same_key[1].end, 4.446, delta=.001)
        self.assertEqual(same_key[1].velocity, 80)
        self.assertAlmostEqual(next(n for n in result if n.pitch == 67).end, 4.737, delta=.001)

    def test_same_tick_detections_coalesce_but_real_repetitions_remain(self):
        out = playable_notes([(0.1001, .3, 60, 70), (.1002, .4, 60, 90),
                              (.25, .1, 60, 50)], .001)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0], (.1, .15, 60, 90))
        self.assertAlmostEqual(out[1][0], .25)
        self.assertEqual(out[1][3], 50)

    def test_pitch_blips_are_filtered_instead_of_lengthened(self):
        times = np.arange(10) * .02
        pitches = np.array([60, 61, 62, 64, 64, 64, 64, 64, 64, 64], dtype=float)
        result = frames_to_notes(times, pitches, min_dur=.07)
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0][0], .06)
        self.assertAlmostEqual(result[0][1], .14)
        self.assertEqual(result[0][2], 64)


class BeatGrid(unittest.TestCase):
    def test_pickup_notes_are_not_collapsed_onto_first_detected_beat(self):
        out = quantize([(0.1, .1, 60), (.35, .1, 64)], bpm=120,
                       origin=1.1, beats=np.array([1.1, 1.6, 2.1]))
        self.assertAlmostEqual(out[0][0], .1)
        self.assertAlmostEqual(out[1][0], .35)

    def test_snaps_to_tracked_beats_not_constant_grid(self):
        # beats slow to 0.5s spacing; a constant 120bpm grid from 0 would put 2.05 at 2.0,
        # the tracked 16th grid (…, 1.875, 2.0, 2.125 …) from beats also gives 2.0 —
        # but at 4.3 the drifted beats (4.25 beat) win over the constant grid's 4.25/4.375 tie.
        beats = np.array([0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0])
        out = quantize([(4.31, 0.1, 60)], bpm=118, origin=0.0, beats=beats)
        self.assertAlmostEqual(out[0][0], 4.25, places=3)

    def test_past_last_beat_falls_back_to_constant_grid(self):
        out = quantize([(9.0, 0.1, 60)], bpm=120, origin=0.0, beats=np.array([0.0, 0.5]))
        self.assertAlmostEqual(out[0][0], 9.0, places=3)


class Gates(unittest.TestCase):
    def test_gate_quiet_drops_notes_in_silence(self):
        times = np.arange(0, 10, 0.5)
        rms = np.where(times < 5, 0.001, 0.1)
        out = gate_quiet([(1.0, 0.5, 40), (7.0, 0.5, 40)], rms, times)
        self.assertEqual(out, [(7.0, 0.5, 40)])

    def test_drop_doubles_removes_overlapping_same_pitch(self):
        out = drop_doubles([(0.0, 1.0, 60), (0.0, 1.0, 64), (2.0, 1.0, 60)], [(0.5, 1.0, 60)])
        self.assertEqual(out, [(0.0, 1.0, 64), (2.0, 1.0, 60)])


class Velocity(unittest.TestCase):
    def test_quantize_keeps_velocity_and_merge_keeps_first(self):
        out = quantize([(0.0, 0.2, 60, 100), (0.2, 0.2, 60, 50)], bpm=120, origin=0.0)
        self.assertEqual(out, [(0.0, 0.5, 60, 100)])

    def test_three_tuples_still_work(self):
        self.assertEqual(quantize([(0.0, 0.25, 60)], bpm=120), [(0.0, 0.25, 60)])


class Quantize(unittest.TestCase):
    def test_grid_origin_is_first_beat_not_zero(self):
        # 120 bpm 16th = 0.125s. First beat at 0.14s; a note 10ms before it
        # must snap to 0.14, not to 0.00 or 0.125.
        notes = [(0.13, 0.4, 60)]
        out = quantize(notes, bpm=120, origin=0.14)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(out[0][0], 0.14, places=3)

    def test_zero_origin_still_snaps_to_sixteenths(self):
        notes = [(0.20, 0.4, 64)]
        out = quantize(notes, bpm=120, origin=0.0)
        self.assertAlmostEqual(out[0][0], 0.25, places=3)

    def test_merges_adjacent_same_pitch(self):
        notes = [(0.0, 0.2, 60), (0.2, 0.2, 60)]
        out = quantize(notes, bpm=120, origin=0.0)
        self.assertEqual(len(out), 1)
        self.assertGreaterEqual(out[0][1], 0.375)


class VocalOnset(unittest.TestCase):
    def test_quiet_intro_then_held_energy(self):
        sr_hop = 0.023
        times = np.arange(0, 20, sr_hop)
        rms = np.full_like(times, 0.001)
        rms[(times >= 8.0)] = 0.12
        t = vocal_onset_time(rms, times)
        self.assertGreater(t, 7.5)
        self.assertLess(t, 8.6)

    def test_karaoke_stem_stays_at_zero(self):
        times = np.linspace(0, 10, 400)
        rms = np.zeros_like(times)
        self.assertEqual(vocal_onset_time(rms, times), 0.0)

    def test_bleed_blip_shorter_than_run_is_ignored(self):
        times = np.arange(0, 12, 0.02)
        rms = np.full_like(times, 0.001)
        rms[(times >= 2.0) & (times < 2.2)] = 0.2  # 200ms leak
        rms[(times >= 9.0)] = 0.15
        t = vocal_onset_time(rms, times, min_run=0.5)
        self.assertGreater(t, 8.5)


class DropGlides(unittest.TestCase):
    def test_strips_chromatic_smear_keeps_held_tone(self):
        notes = [
            (1.25, 0.10, 26),
            (1.35, 0.10, 29),
            (1.45, 0.10, 25),
            (1.55, 0.79, 33),
        ]
        out = drop_glides(notes)
        self.assertEqual(out, [(1.55, 0.79, 33)])

    def test_keeps_short_notes_across_a_real_gap(self):
        notes = [(0.0, 0.10, 60), (0.40, 0.10, 64)]
        self.assertEqual(drop_glides(notes), notes)


class DropBefore(unittest.TestCase):
    def test_strips_notes_before_onset(self):
        notes = [(2.1, 0.8, 53), (9.2, 0.4, 60), (16.4, 0.5, 62)]
        out = drop_before(notes, 9.0)
        self.assertEqual([n[0] for n in out], [9.2, 16.4])

    def test_zero_keeps_everything(self):
        notes = [(0.1, 0.2, 60)]
        self.assertEqual(drop_before(notes, 0.0), notes)


class FindStems(unittest.TestCase):
    def test_other_kept_when_piano_present(self):
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            d = Path(raw)
            (d / "song_vocals.m4a").write_bytes(b"")
            (d / "song_piano.m4a").write_bytes(b"")
            (d / "song_other.m4a").write_bytes(b"")
            (d / "song_bounce.m4a").write_bytes(b"")
            found = find_stems(d)
            self.assertIn("vocals", found)
            self.assertIn("piano", found)
            self.assertIn("other", found)  # dropped later only if silent
            self.assertNotIn("bounce", found)

    def test_other_kept_when_no_harmony_stem(self):
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            d = Path(raw)
            (d / "song_vocals.m4a").write_bytes(b"")
            (d / "song_other.m4a").write_bytes(b"")
            found = find_stems(d)
            self.assertIn("other", found)


if __name__ == "__main__":
    unittest.main()
