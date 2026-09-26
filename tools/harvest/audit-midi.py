"""Read BPM, key signature, time signature, and length from MIDI files.

keys/times list every distinct signature (more than one is not a fact to copy); diatonic is
the share of notes (drums aside) inside the first key signature's scale.

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


PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
MAJOR, MINOR = (0, 2, 4, 5, 7, 9, 11), (0, 2, 3, 5, 7, 8, 10)


def scale(key: str) -> set[int]:
    tonic = (PC[key[0]] + key[1:].count("#") - key[1:].count("b")) % 12
    return {(tonic + i) % 12 for i in (MINOR if key.endswith("m") else MAJOR)}


def meta(path: str) -> dict:
    out = {"path": path, "seconds": None, "bpm": None, "key": None, "time": None,
           "keys": [], "times": [], "diatonic": None, "error": None}
    try:
        mf = mido.MidiFile(path)
        out["seconds"] = round(float(mf.length), 2)
        pcs = []
        for tr in mf.tracks:
            for msg in tr:
                if msg.type == "set_tempo" and out["bpm"] is None:
                    out["bpm"] = int(round(mido.tempo2bpm(msg.tempo)))
                elif msg.type == "key_signature":
                    if msg.key not in out["keys"]:
                        out["keys"].append(msg.key)
                elif msg.type == "time_signature":
                    t = f"{msg.numerator}/{msg.denominator}"
                    if t not in out["times"]:
                        out["times"].append(t)
                elif msg.type == "note_on" and msg.velocity and msg.channel != 9:
                    pcs.append(msg.note % 12)
        out["key"] = out["keys"][0] if out["keys"] else None
        out["time"] = out["times"][0] if out["times"] else None
        if out["key"] and pcs:
            sc = scale(out["key"])
            out["diatonic"] = round(sum(pc in sc for pc in pcs) / len(pcs), 3)
    except Exception as e:
        out["error"] = str(e)[:200]
    return out


paths = json.load(sys.stdin)
if not isinstance(paths, list):
    paths = []
print(json.dumps([meta(str(p)) for p in paths], ensure_ascii=False))
