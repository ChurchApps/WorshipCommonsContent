"""Pure-function checks for the recording-aligned MIDI sketch.

  python tools/pack/test_stems_to_score.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stems_to_score import drop_before, drop_glides, find_stems, quantize, vocal_onset_time


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
    def test_other_dropped_when_piano_present(self):
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
            self.assertNotIn("other", found)
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
