"""Fill inline chords into sources/lyrics.chordpro from a PD SATB ABC.

Walks the content library. Skips songs that already have chords, or whose
lyrics will not align to the ABC. Output stays PD (harmony from Open Hymnal).

  python tools/harvest/backfill-library-chords.py [--only slug]
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ABC2XML = ROOT / "tools" / "vendor" / "abc2xml.py"
PYTHON = os.environ.get("PYTHON", sys.executable)

SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
FLAT_KEYS = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Dm", "Gm", "Cm", "Fm", "Bbm"}
QUALITIES = [
    ((0, 4, 7, 10), "7"), ((0, 3, 7, 10), "m7"), ((0, 4, 7, 11), "maj7"),
    ((0, 4, 7), ""), ((0, 3, 7), "m"), ((0, 3, 6), "dim"), ((0, 4, 8), "aug"),
]
CHORD = re.compile(r"\[[A-G][#b]?")
STRIP = re.compile(r"^\d+\.\s*")
PASSING = ("dim", "aug")
ONLY = None
for i, a in enumerate(sys.argv):
    if a == "--only" and i + 1 < len(sys.argv):
        ONLY = sys.argv[i + 1]


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


def analyze(abc_path: Path):
    from music21 import converter, stream, meter
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run([PYTHON, str(ABC2XML), "-o", td, str(abc_path)], capture_output=True, text=True)
        xml = next(Path(td).glob("*.xml"), None)
        if r.returncode != 0 or not xml:
            raise RuntimeError((r.stderr or r.stdout or "abc2xml failed")[-400:])
        score = converter.parse(str(xml))
    slices = []
    for c in score.chordify().flatten().notes:
        slices.append((
            float(c.offset),
            {p.pitch.pitchClass for p in c.notes} if hasattr(c, "notes") else {p.pitchClass for p in c.pitches},
            min(p.midi for p in c.pitches) % 12,
        ))
    slices.sort()
    bars, beats = [], []
    part0 = score.parts[0] if score.parts else score
    for m in part0.getElementsByClass(stream.Measure):
        ts = m.getContextByClass(meter.TimeSignature)
        bar = float(ts.barDuration.quarterLength) if ts else 4.0
        step = float(ts.beatDuration.quarterLength) if ts else 1.0
        off = float(m.offset)
        bars.append(off)
        b = 0.0
        while b < bar - 1e-6:
            beats.append(off + b)
            b += step
    bars.sort(); beats.sort()
    melody = [n for n in part0.flatten().notes if n.isNote and n.lyrics]
    melody.sort(key=lambda n: float(n.offset))
    return slices, bars, beats, melody


def chord_at(slices, offset):
    active = None
    for off, pcs, bass in slices:
        if off > offset + 1e-6:
            break
        active = (pcs, bass)
    return active


def norm_word(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def build_streams(slices, bars, beats, melody, flats):
    import bisect
    bar_set = set(bars)
    streams = {}
    for n in melody:
        off = float(n.offset)
        i = bisect.bisect_right(beats, off + 1e-6) - 1
        sample = beats[i] if i >= 0 else off
        active = chord_at(slices, sample)
        sym = chord_name(active[0], active[1], flats) if active else None
        if sym and sym.endswith(PASSING) and sample not in bar_set:
            j = bisect.bisect_right(bars, off + 1e-6) - 1
            active = chord_at(slices, bars[j]) if j >= 0 else active
            sym = chord_name(active[0], active[1], flats) if active else None
        for lyr in n.lyrics:
            if not lyr.text:
                continue
            text = STRIP.sub("", lyr.text)
            st = streams.setdefault(lyr.number, {"words": [], "last": None, "open": False})
            chord = sym if sym and sym != st["last"] else None
            if chord:
                st["last"] = sym
            if st["open"] and st["words"]:
                st["words"][-1].append((chord, text))
            else:
                st["words"].append([(chord, text)])
            st["open"] = lyr.syllabic in ("begin", "middle")
    return {k: v["words"] for k, v in streams.items()}


def render_line(words):
    return " ".join("".join((f"[{c}]" if c else "") + s for c, s in word) for word in words)


def align_line(lw, words, cur):
    W = words[cur:cur + len(lw) + 4]
    wnorm = [norm_word("".join(s for _, s in w)) for w in W]
    lnorm = [norm_word(a) for a in lw]

    @lru_cache(maxsize=None)
    def dp(i, j):
        if i == len(lw):
            return 0, ()
        best = None
        if j < len(W):
            c, ops = dp(i + 1, j + 1)
            cand = (c + (0 if lnorm[i] == wnorm[j] else 1), (("m", i, j),) + ops)
            best = cand if best is None or cand < best else best
        if j + 1 < len(W) and lnorm[i] == wnorm[j] + wnorm[j + 1]:
            c, ops = dp(i + 1, j + 2)
            cand = (c, (("g", i, j),) + ops)
            best = cand if best is None or cand < best else best
        if j < len(W):
            c, ops = dp(i, j + 1)
            cand = (c + 1, (("sw", i, j),) + ops)
            best = cand if best is None or cand < best else best
        c, ops = dp(i + 1, j)
        cand = (c + 1, (("sl", i, j),) + ops)
        return cand if best is None or cand < best else best

    cost, ops = dp(0, 0)
    if cost > max(1, len(lw) // 5):
        return None
    rendered, consumed = [], 0
    for op, i, j in ops:
        if op == "m":
            rendered.append(W[j]); consumed = j + 1
        elif op == "g":
            rendered.append(W[j] + W[j + 1]); consumed = j + 2
        elif op == "sw":
            consumed = j + 1
        else:
            rendered.append([(None, lw[i])])
    return cost, rendered, cur + consumed


def annotate(chord_pro, streams):
    stanzas = chord_pro.split("\n\n")
    cursors = {k: 0 for k in streams}
    out_stanzas = []
    for stanza in stanzas:
        lines = stanza.split("\n")
        label, body = lines[0], lines[1:]
        vm = re.match(r"Verse (\d+)$", label)
        new_body = []
        for line in body:
            lw = line.split()
            cands = [int(vm.group(1))] if vm else sorted(streams)
            best = None
            for k in cands:
                if k not in streams:
                    continue
                a = align_line(lw, streams[k], cursors[k])
                if a and (best is None or a[0] < best[0][0]):
                    best = (a, k)
            if best is None:
                for k in cands:
                    if k not in streams:
                        continue
                    for start in range(len(streams[k])):
                        a = align_line(lw, streams[k], start)
                        if a and a[0] == 0:
                            if best is None or a[0] < best[0][0]:
                                best = (a, k)
                            break
            if best is None:
                return None
            (_, rendered, new_cur), k = best
            new_body.append(render_line(rendered))
            cursors[k] = new_cur
        out_stanzas.append("\n".join([label] + new_body))
    return "\n\n".join(out_stanzas)


def split_chordpro(text: str):
    lines = text.replace("\n$", "").rstrip("\n").split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith("{"):
        i += 1
    if i < len(lines) and lines[i] == "":
        i += 1
    return "\n".join(lines[:i]).rstrip("\n"), "\n".join(lines[i:])


def find_abc(song_dir: Path, work_ref: str | None, works: dict[str, Path]) -> Path | None:
    own = song_dir / "sources" / "tune.abc"
    if own.exists():
        return own
    if work_ref and work_ref in works:
        w = works[work_ref] / "sources" / "tune.abc"
        if w.exists():
            return w
    return None


def main():
    works = {}
    wr = ROOT / "works"
    if wr.exists():
        for d in wr.iterdir():
            if d.is_dir():
                works[d.name] = d
    stats = {"done": 0, "has_chords": 0, "no_abc": 0, "skip": 0, "fail": 0}
    fails = []
    songs = sorted((ROOT / "songs").rglob("lyrics.chordpro"))
    for lyrics in songs:
        if lyrics.parent.name != "sources":
            continue
        d = lyrics.parent.parent
        rel = str(d.relative_to(ROOT)).replace("\\", "/")
        if ONLY and ONLY not in rel and ONLY not in d.name:
            continue
        song = json.loads((d / "song.json").read_text(encoding="utf-8"))
        raw = lyrics.read_text(encoding="utf-8")
        header, body = split_chordpro(raw)
        if CHORD.search(body):
            stats["has_chords"] += 1
            continue
        abc = find_abc(d, song.get("workRef"), works)
        if not abc:
            stats["no_abc"] += 1
            continue
        try:
            slices, bars, beats, melody = analyze(abc)
            if not melody:
                stats["skip"] += 1
                continue
            key = song.get("key") or ""
            flats = key in FLAT_KEYS or "b" in key
            annotated = annotate(body, build_streams(slices, bars, beats, melody, flats))
        except Exception as e:
            stats["fail"] += 1
            fails.append(f"{rel}: {type(e).__name__} {e}")
            continue
        if not annotated:
            stats["skip"] += 1
            continue
        out = (header + "\n\n" if header else "") + annotated
        if not out.endswith("\n"):
            out += "\n"
        lyrics.write_text(out, encoding="utf-8", newline="\n")
        stats["done"] += 1
        print(f"  chords {rel}", flush=True)
    print("backfill:", stats)
    for f in fails[:20]:
        print(" fail:", f)
    if len(fails) > 20:
        print(f" ... and {len(fails) - 20} more")
    return 0 if stats["fail"] < 50 else 1


if __name__ == "__main__":
    sys.exit(main())
