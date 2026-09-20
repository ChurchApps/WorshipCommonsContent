"""Read BPM, key signature, time signature, and length from MIDI files.

Called by audit-catalog.mjs. Stdin: JSON array of paths. Stdout: JSON array.
"""
from __future__ import annotations

import json
import sys

try:
    import mido
except ImportError:
    print("[]")
    sys.exit(0)


def meta(path: str) -> dict:
    out = {"path": path, "seconds": None, "bpm": None, "key": None, "time": None, "error": None}
    try:
        mf = mido.MidiFile(path)
        out["seconds"] = round(float(mf.length), 2)
        for tr in mf.tracks:
            for msg in tr:
                if msg.type == "set_tempo" and out["bpm"] is None:
                    out["bpm"] = int(round(mido.tempo2bpm(msg.tempo)))
                elif msg.type == "key_signature" and out["key"] is None:
                    out["key"] = msg.key
                elif msg.type == "time_signature" and out["time"] is None:
                    out["time"] = f"{msg.numerator}/{msg.denominator}"
    except Exception as e:
        out["error"] = str(e)[:200]
    return out


paths = json.load(sys.stdin)
if not isinstance(paths, list):
    paths = []
print(json.dumps([meta(str(p)) for p in paths], ensure_ascii=False))
