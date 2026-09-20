#!/usr/bin/env python3
"""score.musicxml -> score.mid, via music21.

  python tools/generate/xml2midi.py <score.musicxml> <score.mid>

Named score.mid, not tune.mid: sources/tune.mid is a hymnal MIDI someone gave us,
this is the notes of our own score rendered out. Different owner, different file.
"""
import sys
from pathlib import Path


def main() -> int:
    src, dest = Path(sys.argv[1]), Path(sys.argv[2])
    from music21 import converter

    score = converter.parse(str(src))
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Some engravings carry repeats music21 cannot expand (an unmatched end repeat,
    # a D.S. with no sign). Play the notes through once rather than failing.
    try:
        score.expandRepeats()
    except Exception:
        from music21 import bar, repeat
        for el in list(score.recurse().getElementsByClass((bar.Repeat, repeat.RepeatExpression))):
            el.activeSite.remove(el)
    tmp = dest.with_suffix(".mid.tmp")
    score.write("midi", fp=str(tmp))
    # byte-compare before replacing: a churned mtime would rebuild the stems pack
    if dest.exists() and dest.read_bytes() == tmp.read_bytes():
        tmp.unlink()
        print("unchanged")
        return 0
    tmp.replace(dest)
    print("written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
