"""Proofread a hand transcription (sources/tune.abc) against the writer's MIDI melody.

    python tools/check-abc-midi.py songs/en/<slug>-<id> [--track N]

Compares the melody pitch sequence of tune.abc (repeats unfolded, ties merged) with
the melody track of sources/tune.mid, and prints every stretch where they differ,
with the ABC bar number. Pitch only: the written sheet owns rhythm and form, and a
MIDI is a performance (anticipations, extra choruses), so expect some structural
blocks. Each non-structural difference is a line to re-check against the PDF.
The melody track is the first one named like "melody", else --track.
"""
import argparse, difflib, pathlib, subprocess, sys, tempfile, warnings

warnings.filterwarnings("ignore")
import mido
from music21 import converter

HERE = pathlib.Path(__file__).resolve().parent
NAMES = "C C# D D# E F F# G G# A A# B".split()
name = lambda n: f"{NAMES[n % 12]}{n // 12 - 1}"


def abc_melody(abc):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, str(HERE / "vendor" / "abc2xml.py"), "-o", tmp, str(abc)], check=True, capture_output=True)
        score = converter.parse(next(pathlib.Path(tmp).glob("*.xml")))
    part = score.parts[0].expandRepeats()
    notes = []
    for m in part.getElementsByClass("Measure"):
        for n in m.notes:
            if n.isChord:  # chord symbols and harmony notes: not the tune
                continue
            if n.tie and n.tie.type in ("continue", "stop"):
                continue
            notes.append((n.pitch.midi, m.number))
    return notes


def midi_melody(mid, track):
    f = mido.MidiFile(mid)
    if track is None:
        track = next((i for i, t in enumerate(f.tracks) if "melody" in (t.name or "").lower()), None)
        if track is None:
            sys.exit("no track named like 'melody': pass --track (tracks: " + ", ".join(f"{i}={t.name!r}" for i, t in enumerate(f.tracks)) + ")")
    bar = 4 * f.ticks_per_beat
    now, notes = 0, []
    for msg in f.tracks[track]:
        now += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            notes.append((msg.note, now // bar + 1))
    return notes, f.tracks[track].name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song")
    ap.add_argument("--track", type=int)
    a = ap.parse_args()
    src = pathlib.Path(a.song) / "sources"
    if not (src / "tune.abc").exists():
        sys.exit(f"{src / 'tune.abc'} does not exist yet")
    abc = abc_melody(src / "tune.abc")
    mid, tname = midi_melody(src / "tune.mid", a.track)
    sm = difflib.SequenceMatcher(a=[p for p, _ in abc], b=[p for p, _ in mid], autojunk=False)
    print(f"ABC {len(abc)} notes | MIDI track {tname!r} {len(mid)} notes | pitch match {sm.ratio():.0%}")
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        where = f"ABC bar {abc[i1][1]}" if i1 < len(abc) else "ABC end"
        left = " ".join(name(p) for p, _ in abc[i1:i2]) or "-"
        right = " ".join(name(p) for p, _ in mid[j1:j2]) or "-"
        kind = "structure" if max(i2 - i1, j2 - j1) > 8 else op
        print(f"  {where:12} {kind:9} ABC: {left[:70]}\n  {'':12} {'':9} MIDI bar {mid[j1][1] if j1 < len(mid) else '-'}: {right[:70]}")


if __name__ == "__main__":
    main()
