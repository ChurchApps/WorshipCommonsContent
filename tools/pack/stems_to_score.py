"""Transcribe a vocal stem to MIDI + MusicXML and underlay lyrics.chordpro.

  python tools/pack/stems_to_score.py <vocals.wav|.m4a> <lyrics.chordpro> <out_dir> [--bpm 80]

Writes out_dir/score.mid and out_dir/score.musicxml. Tries out_dir/lead-sheet.pdf
via MuseScore or Verovio when either is present.

This is a generated sketch (same class as a MIDI import): pitches from the
recording, words from the chordpro master. It is not a proofread score. A person
promotes it to sources/score.musicxml after checking it.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

SECTION = re.compile(
    r"^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus)\b",
    re.I,
)


def _ffmpeg_wav(src: Path, dest: Path) -> None:
    r = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-ac", "1", "-ar", "22050", "-acodec", "pcm_s16le", str(dest)],
        capture_output=True, text=True,
    )
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or "ffmpeg failed")


def detect_tempo(y: np.ndarray, sr: int, hint: float | None) -> float:
    import librosa

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr, units="time")
    if isinstance(tempo, np.ndarray):
        tempo = float(tempo[0]) if tempo.size else 0.0
    tempo = float(tempo)
    if hint and 40 <= hint <= 220 and (tempo < 40 or abs(tempo - hint) > 25):
        # harvest placeholder 80 is only a hint; prefer the recording when librosa is sure
        if tempo >= 40:
            return round(tempo)
        return float(hint)
    if tempo < 40 or tempo > 220:
        return float(hint or 80)
    return round(tempo)


def frames_to_notes(times: np.ndarray, midi: np.ndarray, min_dur: float = 0.09) -> list[tuple[float, float, int]]:
    notes: list[tuple[float, float, int]] = []
    i, n = 0, len(midi)
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        pitch = int(np.clip(round(float(midi[i])), 36, 84))
        j = i + 1
        while j < n and not np.isnan(midi[j]) and abs(float(midi[j]) - pitch) < 0.7:
            j += 1
        start = float(times[i])
        end = float(times[min(j, n - 1)])
        dur = max(end - start, min_dur)
        if dur >= min_dur:
            notes.append((start, dur, pitch))
        i = j
    return notes


def quantize(notes: list[tuple[float, float, int]], bpm: float) -> list[tuple[float, float, int]]:
    grid = 60.0 / bpm / 4  # 16th
    out = []
    for start, dur, pitch in notes:
        s = round(start / grid) * grid
        d = max(grid, round(dur / grid) * grid)
        if out and abs(out[-1][2] - pitch) < 1 and s <= out[-1][0] + out[-1][1] + grid:
            ps, pd, pp = out[-1]
            out[-1] = (ps, max(pd, s + d - ps), pp)
        else:
            out.append((max(0.0, s), d, pitch))
    return out


def parse_lyrics(chordpro: str) -> list[tuple[str, list[str]]]:
    lines = chordpro.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith("{"):
        i += 1
    if i < len(lines) and lines[i].strip() == "":
        i += 1
    sections: list[tuple[str, list[str]]] = []
    label, words = "Verse", []
    for line in lines[i:]:
        t = re.sub(r"\[[^\]]*\]", "", line).strip()
        if not t or t.startswith("#"):
            continue
        if SECTION.match(t):
            if words:
                sections.append((label, words))
            label, words = t, []
            continue
        words.extend(t.split())
    if words:
        sections.append((label, words))
    return sections


def transcribe(vocals: Path, lyrics_path: Path, out_dir: Path, bpm_hint: float | None = None) -> dict:
    import librosa
    import pretty_midi
    from music21 import clef, key, meter, note, stream, tempo

    out_dir.mkdir(parents=True, exist_ok=True)
    wav = out_dir / "_vocals.wav"
    _ffmpeg_wav(vocals, wav)
    y, sr = librosa.load(str(wav), sr=22050, mono=True)
    wav.unlink(missing_ok=True)

    bpm = detect_tempo(y, sr, bpm_hint)
    fmin = librosa.note_to_hz("C2")
    fmax = librosa.note_to_hz("C6")
    f0, voiced, _ = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr)
    times = librosa.times_like(f0, sr=sr)
    midi_f = np.where(voiced, librosa.hz_to_midi(f0), np.nan)
    raw = frames_to_notes(times, midi_f)
    notes = quantize(raw, bpm)
    if not notes:
        raise RuntimeError(f"no pitched notes in {vocals.name}")

    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    inst = pretty_midi.Instrument(program=0, name="Melody")
    for start, dur, pitch in notes:
        inst.notes.append(pretty_midi.Note(velocity=90, pitch=pitch, start=start, end=start + dur))
    pm.instruments.append(inst)
    mid_path = out_dir / "score.mid"
    pm.write(str(mid_path))

    s = stream.Part()
    s.id = "P1"
    s.partName = "Melody"
    s.insert(0, clef.TrebleClef())
    s.insert(0, meter.TimeSignature("4/4"))
    s.insert(0, tempo.MetronomeMark(number=bpm))
    offset = 0.0
    ql_grid = 1.0  # quarter at this bpm maps to 60/bpm seconds; music21 quarterLength
    sec_per_ql = 60.0 / bpm
    for start, dur, pitch in notes:
        gap = start - offset
        if gap > 0.04:
            r = note.Rest()
            r.quarterLength = max(0.25, round((gap / sec_per_ql) * 4) / 4)
            s.append(r)
        n = note.Note(pitch)
        n.quarterLength = max(0.25, round((dur / sec_per_ql) * 4) / 4)
        s.append(n)
        offset = start + dur

    sections = parse_lyrics(lyrics_path.read_text(encoding="utf-8"))
    words: list[tuple[str, str]] = []
    for label, toks in sections:
        first = True
        for w in toks:
            words.append((label if first else "", w))
            first = False
    melody_notes = [n for n in s.recurse().notes if isinstance(n, note.Note)]
    for i, n in enumerate(melody_notes):
        if i >= len(words):
            break
        label, w = words[i]
        n.lyric = w
        if label:
            from music21 import expressions
            n.expressions.append(expressions.RehearsalMark(label))

    k = s.analyze("key")
    s.insert(0, key.Key(k.tonic.name, k.mode))

    score = stream.Score()
    score.insert(0, s)
    xml_path = out_dir / "score.musicxml"
    score.write("musicxml", fp=str(xml_path))

    sheet = _write_sheet(xml_path, out_dir)

    return {
        "bpm": bpm,
        "key": f"{k.tonic.name}{'m' if k.mode == 'minor' else ''}",
        "notes": len(melody_notes),
        "midi": str(mid_path),
        "musicxml": str(xml_path),
        "pdf": str(sheet) if sheet and sheet.suffix == ".pdf" else None,
        "sheet": str(sheet) if sheet else None,
    }


def _write_sheet(xml: Path, out_dir: Path) -> Path | None:
    pdf = out_dir / "lead-sheet.pdf"
    mscore = _musescore()
    if mscore:
        r = subprocess.run([mscore, "-o", str(pdf), str(xml)], capture_output=True, text=True)
        if r.returncode == 0 and pdf.exists():
            return pdf
    svg = out_dir / "lead-sheet.svg"
    try:
        import verovio

        tk = verovio.toolkit()
        tk.setOptions({"adjustPageHeight": True})
        tk.loadFile(str(xml))
        tk.renderToSVGFile(str(svg))
        if svg.exists():
            return svg
    except Exception:
        pass
    return None


def _musescore() -> str | None:
    for name in ("MuseScore4", "MuseScore3", "mscore4", "mscore3", "mscore"):
        p = shutil.which(name)
        if p:
            return p
    for p in (
        Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe"),
        Path(r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe"),
    ):
        if p.exists():
            return str(p)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vocals")
    ap.add_argument("lyrics")
    ap.add_argument("out_dir")
    ap.add_argument("--bpm", type=float, default=None)
    args = ap.parse_args()
    info = transcribe(Path(args.vocals), Path(args.lyrics), Path(args.out_dir), args.bpm)
    print(
        f"transcribed {info['notes']} notes, {info['key']} @ {info['bpm']} bpm"
        f"{'' if info.get('sheet') else ' (no sheet renderer)'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
