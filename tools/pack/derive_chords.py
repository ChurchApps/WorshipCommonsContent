"""Derive inline chords for sources/lyrics.chordpro from the recording-sketch MIDI.

Reads output/composition/score.mid (accompaniment tracks, on the recording's
timeline) and sources/timing.json (per-word times on the same timeline), names
the chord sounding at each beat, and writes `[A]` before the first word sung at
or after each chord change. Falls back to sources/tune.mid when there is no
sketch; then the words are placed by the MIDI's own tempo map, which only works
when the MIDI and the timing file line up.

  python tools/pack/derive_chords.py <package-dir> [--write] [--force]

Without --write it prints the chorded body. Skips packages whose lyrics
already carry chords unless --force.
"""
from __future__ import annotations

import bisect
import json
import re
import sys
from pathlib import Path

import mido

SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
FLAT_KEYS = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Dm", "Gm", "Cm", "Fm", "Bbm"}
QUALITIES = [
    ((0, 4, 7, 10), "7"), ((0, 3, 7, 10), "m7"), ((0, 4, 7, 11), "maj7"),
    ((0, 4, 7), ""), ((0, 3, 7), "m"),
]  # ponytail: no dim/aug/slash — transcribed accompaniment is too noisy to trust them
CHORD_TOKEN = re.compile(r"\[[A-G][#b]?[^\]]*\]")
SKIP_TRACKS = re.compile(r"melody|vocal|voice|drum|perc|click", re.I)


def chord_name(pcs: set[int], bass_pc: int, flats: bool) -> str | None:
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
    if not best:
        return None
    return best[1]


def notes_and_beats(mid: Path):
    """Absolute-second note spans on accompaniment tracks, plus beat times from the tempo map."""
    m = mido.MidiFile(str(mid))
    tpb = m.ticks_per_beat
    # tempo map (tick -> seconds), merged across tracks
    tmap = {0: 500000}
    for tr in m.tracks:
        for tick, msg in _abs(tr):
            if msg.type == "set_tempo":
                tmap[tick] = msg.tempo
    tempos = sorted(tmap.items())
    def to_sec(tick: int) -> float:
        s, last_tick, tempo = 0.0, 0, tempos[0][1]
        for t_tick, t_tempo in tempos:
            if t_tick >= tick:
                break
            s += (t_tick - last_tick) * tempo / tpb / 1e6
            last_tick, tempo = t_tick, t_tempo
        return s + (tick - last_tick) * tempo / tpb / 1e6
    spans: list[tuple[float, float, int]] = []
    end_tick = 0
    for tr in m.tracks:
        name = next((x.name for x in tr if x.type == "track_name"), "")
        chan = {x.channel for x in tr if hasattr(x, "channel")}
        events = _abs(tr)
        end_tick = max(end_tick, events[-1][0] if events else 0)
        if SKIP_TRACKS.search(name) or chan == {9}:
            continue
        on: dict[tuple[int, int], int] = {}
        for tick, msg in events:
            if msg.type == "note_on" and msg.velocity > 0:
                on[(msg.channel, msg.note)] = tick
            elif msg.type in ("note_off", "note_on"):
                st = on.pop((msg.channel, msg.note), None)
                if st is not None and msg.channel != 9:
                    spans.append((to_sec(st), to_sec(tick), msg.note))
    beats = [to_sec(t) for t in range(0, end_tick + 1, tpb)]
    return spans, beats


def _abs(track):
    out, t = [], 0
    for msg in track:
        t += msg.time
        out.append((t, msg))
    return out


def chords_by_time(spans, beats, flats: bool) -> list[tuple[float, str]]:
    """(seconds, chord) at each change, sampled on beats; a chord must hold a full beat to count."""
    spans.sort()
    starts = [s for s, _, _ in spans]
    out: list[tuple[float, str]] = []
    for i, b in enumerate(beats):
        nxt = beats[i + 1] if i + 1 < len(beats) else b + 0.5
        mid = (b + nxt) / 2
        j = bisect.bisect_right(starts, mid)
        sounding = [n for s, e, n in spans[:j] if e > mid]
        if not sounding:
            continue
        pcs = {n % 12 for n in sounding}
        name = chord_name(pcs, min(sounding) % 12, flats)
        if name and (not out or out[-1][1] != name):
            out.append((b, name))
    # ponytail: drop one-beat blips between identical chords (passing tones read as chords)
    cleaned: list[tuple[float, str]] = []
    for i, (t, c) in enumerate(out):
        prev = cleaned[-1] if cleaned else None
        nxt = out[i + 1] if i + 1 < len(out) else None
        if prev and nxt and prev[1] == nxt[1] and nxt[0] - t < 1.01 * (beats[1] - beats[0] if len(beats) > 1 else 1):
            continue
        cleaned.append((t, c))
    return cleaned


def place(timing: dict, chords: list[tuple[float, str]]) -> list[tuple[str, list[str]]]:
    """Stanzas of ChordPro lines: each chord goes before the first word at/after its onset."""
    times = [t for t, _ in chords]
    stanzas = []
    k = 0  # next chord index to emit
    for st in timing["stanzas"]:
        lines = []
        for words in st["lines"]:
            parts = []
            for w in words:
                pre = ""
                while k < len(chords) and chords[k][0] <= w["t"] + w["d"] * 0.5:
                    pre = f"[{chords[k][1]}]"  # several chords before one word: keep the last
                    k += 1
                parts.append(pre + w["text"])
            lines.append(" ".join(parts))
        stanzas.append((st["label"], lines))
    return stanzas


def stamp_manifest(pkg: Path, lyrics: Path, mid: Path) -> None:
    """Refresh the lyrics.chordpro row's sha256 and note where the chords came from."""
    import hashlib
    man = pkg / "sources" / "manifest.json"
    if not man.exists():
        return
    doc = json.loads(man.read_text(encoding="utf-8"))
    for row in doc.get("files", []):
        if row.get("file") == "lyrics.chordpro":
            row["sha256"] = hashlib.sha256(lyrics.read_bytes()).hexdigest()
            row["chords"] = f"derived from {mid.relative_to(pkg).as_posix()}"
    man.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    write, force = "--write" in argv, "--force" in argv
    pkg = Path(args[0]).resolve()
    lyrics = pkg / "sources" / "lyrics.chordpro"
    text = lyrics.read_text(encoding="utf-8")
    if CHORD_TOKEN.search(text) and not force:
        print("already has chords")
        return 0
    timing_p = pkg / "sources" / "timing.json"
    mid = next((p for p in (pkg / "output" / "composition" / "score.mid", pkg / "sources" / "tune.mid") if p.exists()), None)
    if not mid or not timing_p.exists():
        print("no chords: need timing.json and a midi")
        return 0
    song = json.loads((pkg / "song.json").read_text(encoding="utf-8"))
    flats = (song.get("key") or "") in FLAT_KEYS
    spans, beats = notes_and_beats(mid)
    chords = chords_by_time(spans, beats, flats)
    stanzas = place(json.loads(timing_p.read_text(encoding="utf-8")), chords)
    head, _, _ = text.partition("\n\n")
    body = "\n\n".join(f"{label}\n" + "\n".join(lines) for label, lines in stanzas)
    out = f"{head}\n\n{body}\n"
    n = sum(1 for _ in CHORD_TOKEN.finditer(body))
    print(f"{mid.name}: {len(chords)} chord changes, {n} placed")
    if write:
        lyrics.write_text(out, encoding="utf-8", newline="\n")
        stamp_manifest(pkg, lyrics, mid)
    else:
        print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
