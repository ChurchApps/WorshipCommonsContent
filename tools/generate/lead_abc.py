"""Write output/composition/lead.abc — melody + guitar-chord annotations from SATB ABC.

  python tools/generate/lead_abc.py --root <content> [--only slug]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from fractions import Fraction

PYTHON = os.environ.get("PYTHON", sys.executable)
FLAT_KEYS = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Dm", "Gm", "Cm", "Fm", "Bbm"}
SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
QUALITIES = [
    ((0, 4, 7, 10), "7"), ((0, 3, 7, 10), "m7"), ((0, 4, 7, 11), "maj7"),
    ((0, 4, 7), ""), ((0, 3, 7), "m"), ((0, 3, 6), "dim"), ((0, 4, 8), "aug"),
]


def chord_name(pcs, bass_pc, flats):
    names = FLAT if flats else SHARP
    best = None
    for root in sorted(pcs):
        rel = frozenset((p - root) % 12 for p in pcs)
        for ivs, suffix in QUALITIES:
            covered = rel & set(ivs)
            if 0 not in covered or rel - set(ivs):
                continue
            score = (len(covered), root == bass_pc, -len(ivs))
            if best is None or score > best[0]:
                best = (score, names[root] + suffix)
    return best[1] if best else None


def abc_pitch(p):
    acc = p.accidental
    pre = ""
    if acc:
        if acc.alter == 1:
            pre = "^"
        elif acc.alter == -1:
            pre = "_"
        elif acc.alter >= 2:
            pre = "^^"
        elif acc.alter <= -2:
            pre = "__"
    letter = p.step
    octv = p.octave or 4
    if octv >= 5:
        body = letter.lower() + ("'" * (octv - 5))
    elif octv == 4:
        body = letter
    else:
        body = letter + ("," * (4 - octv))
    return pre + body


def abc_len(ql, unit=1.0):
    rel = ql / unit
    if abs(rel - 1) < 1e-6:
        return ""
    f = Fraction(rel).limit_denominator(16)
    if f.denominator == 1:
        return str(f.numerator)
    if f.numerator == 1:
        return f"/{f.denominator}"
    return f"{f.numerator}/{f.denominator}"


def convert(abc_path: Path, abc2xml: Path):
    from music21 import converter
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run([PYTHON, str(abc2xml), "-o", td, str(abc_path)], capture_output=True, text=True)
        xml = next(Path(td).glob("*.xml"), None)
        if r.returncode != 0 or not xml:
            raise RuntimeError((r.stderr or r.stdout or "abc2xml failed")[-400:])
        return converter.parse(str(xml))


def lead_from_score(score, title: str, key: str, meter: str) -> str:
    melody = score.parts[0] if score.parts else score
    # abc2xml sometimes stacks SATB onto one part — keep the top note at each offset
    by_off = {}
    for n in melody.flatten().notes:
        off = round(float(n.offset), 4)
        cand = n if n.isNote else (max(n.notes, key=lambda x: x.pitch.midi) if n.isChord else None)
        if cand is None:
            continue
        prev = by_off.get(off)
        if prev is None or cand.pitch.midi > prev.pitch.midi:
            by_off[off] = cand
    top_notes = [by_off[k] for k in sorted(by_off)]
    slices = []
    for c in score.chordify().flatten().notes:
        pcs = {p.pitch.pitchClass for p in c.notes} if hasattr(c, "notes") else {p.pitchClass for p in c.pitches}
        bass = min(p.midi for p in c.pitches) % 12
        slices.append((float(c.offset), pcs, bass))
    slices.sort()
    flats = key in FLAT_KEYS or "b" in (key or "")
    unit = 1.0
    m = re.match(r"(\d+)/(\d+)", meter or "4/4")
    ts = f"{m.group(1)}/{m.group(2)}" if m else "4/4"
    k = key or "C"
    rest_offs = [n for n in melody.flatten().notesAndRests if n.isRest]
    notes = []
    ri = 0
    for n in top_notes:
        while ri < len(rest_offs) and float(rest_offs[ri].offset) < float(n.offset) - 1e-6:
            notes.append(rest_offs[ri]); ri += 1
        notes.append(n)
    bars = []
    cur = []
    last_bar = 0
    last_chord = None
    for n in notes:
        off = float(n.offset)
        bar = int(off // (int(ts.split("/")[0]) * (4 / int(ts.split("/")[1]))))
        if cur and bar != last_bar:
            bars.append(cur)
            cur = []
        last_bar = bar
        if n.isRest:
            cur.append(("z", abc_len(float(n.quarterLength), unit), None, None))
            continue
        if not n.isNote:
            continue
        active = None
        for soff, pcs, bass in slices:
            if soff > off + 1e-6:
                break
            active = (pcs, bass)
        sym = chord_name(active[0], active[1], flats) if active else None
        if sym == last_chord:
            chord = None
        else:
            chord = sym
            last_chord = sym
        lyric = None
        if n.lyrics:
            lyric = "".join(ly.text or "" for ly in n.lyrics if ly.number in (1, None) or ly.number == 1)
            if n.lyrics[0].syllabic in ("begin", "middle") and lyric:
                lyric = lyric + "-"
        cur.append((abc_pitch(n.pitch), abc_len(float(n.quarterLength), unit), chord, lyric))
    if cur:
        bars.append(cur)

    body_lines = []
    w_lines = []
    for bar in bars:
        toks = []
        words = []
        for pitch, leng, chord, lyric in bar:
            tok = (f'"{chord}"' if chord else "") + pitch + leng
            toks.append(tok)
            if lyric:
                words.append(lyric)
        body_lines.append(" ".join(toks) + " |")
        if words:
            w_lines.append("w: " + " ".join(words))
    header = [
        "X:1",
        f"T: {title}",
        "C: Lead sheet — melody + chords from the SATB setting. Public domain.",
        f"M: {ts}",
        "L: 1/4",
        f"K: {k}",
    ]
    out = header + body_lines[:1]
    # interleave w: under the first pass of bars if we collected them as one stream
    # (one w: after all bars is fine for abcjs)
    lines = header + []
    # rebuild: dump bars, then a single w: for verse 1 if present
    lines = header[:]
    for i, bar in enumerate(bars):
        toks = []
        for pitch, leng, chord, lyric in bar:
            toks.append((f'"{chord}"' if chord else "") + pitch + leng)
        end = " |" if i < len(bars) - 1 else " |]"
        lines.append(" ".join(toks) + end)
    if w_lines:
        # one lyric line covering the whole tune (abcjs places it under the staff)
        verse1 = " ".join(w.replace("w: ", "") for w in w_lines)
        lines.append("w: " + verse1)
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    root = Path(args.root)
    abc2xml = root / "tools" / "vendor" / "abc2xml.py"
    stats = {"ok": 0, "skip": 0, "fail": 0}
    abcs = list((root / "songs").rglob("tune.abc"))
    for abc in abcs:
        if abc.parent.name != "sources":
            continue
        rel = str(abc).replace("\\", "/")
        if args.only and args.only not in rel:
            continue
        pkg = abc.parent.parent
        dest = pkg / "output" / "composition" / "lead.abc"
        if not args.force and dest.exists() and dest.stat().st_mtime >= abc.stat().st_mtime:
            stats["skip"] += 1
            continue
        title = pkg.name
        key = "C"
        meta = pkg / "song.json"
        if not meta.exists():
            meta = pkg / "work.json"
        meter = "4/4"
        if meta.exists():
            song = json.loads(meta.read_text(encoding="utf-8"))
            title = song.get("title") or title
            key = song.get("key") or key
            meter = song.get("timeSignature") or meter
        # ABC K: wins when present
        raw = abc.read_text(encoding="utf-8", errors="ignore")
        km = re.search(r"^K:\s*([A-G][#b]?m?)", raw, re.M)
        if km:
            key = km.group(1)
        mm = re.search(r"^M:\s*(\S+)", raw, re.M)
        if mm:
            meter = mm.group(1)
        try:
            score = convert(abc, abc2xml)
            text = lead_from_score(score, title, key, meter)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, encoding="utf-8", newline="\n")
            stats["ok"] += 1
        except Exception as e:
            stats["fail"] += 1
            print(f" fail {rel}: {type(e).__name__} {e}", flush=True)
    print("lead_abc:", stats)
    return 0 if stats["fail"] < 50 else 1


if __name__ == "__main__":
    sys.exit(main())
