"""Transcribe a granted mix to MIDI + MusicXML and underlay lyrics.chordpro.

  python tools/pack/stems_to_score.py <vocals.wav|.m4a> <lyrics.chordpro> <out_dir> [--bpm 80]
  python tools/pack/stems_to_score.py <vocals> <lyrics> <out_dir> --stems-dir <stems> --mix <master.mp3>

Writes out_dir/score.mid and out_dir/score.musicxml. Tries out_dir/lead-sheet.pdf
via MuseScore or Verovio when either is present.

score.mid is a sketch of the recording: pitched stems (vocals, piano, guitar,
bass, leftover other) plus a simple drum track, on the mix's beat grid, with
the mix's intro left in place. MusicXML is still the melody + words — a person
promotes it to sources/score.musicxml after checking it. sources/tune.mid is
someone else's file and is never written here.
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
AUDIO_EXT = {".wav", ".flac", ".m4a", ".mp3", ".aiff", ".aif", ".ogg", ".opus"}
# MelBand leftover "other" doubles piano/guitar when those stems already exist.
PITCHED = ("vocals", "piano", "guitar", "bass", "other")
GM = {
    "vocals": (53, "Melody"),   # choir aahs — sits on top of the band sketch
    "piano": (0, "Piano"),
    "guitar": (25, "Guitar"),
    "bass": (33, "Bass"),
    "other": (48, "Other"),
}
RANGE = {
    "vocals": ("C3", "C6"),
    "piano": ("C1", "C7"),
    "guitar": ("E2", "C6"),
    "bass": ("E1", "C4"),
    "other": ("C2", "C6"),
}


def _ffmpeg_wav(src: Path, dest: Path) -> None:
    r = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-ac", "1", "-ar", "22050", "-acodec", "pcm_s16le", str(dest)],
        capture_output=True, text=True,
    )
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or "ffmpeg failed")


def load_mono(path: Path, sr: int = 22050) -> tuple[np.ndarray, int]:
    """Decode any stem/mix to mono PCM. librosa cannot always open AAC."""
    import librosa
    import soundfile

    wav = path.with_name(path.stem + ".__sts.wav") if path.suffix.lower() != ".wav" else path
    tmp = wav != path
    if tmp:
        _ffmpeg_wav(path, wav)
    try:
        y, file_sr = soundfile.read(str(wav), always_2d=False)
        if y.ndim > 1:
            y = y.mean(axis=1)
        y = np.ascontiguousarray(y, dtype=np.float32)
        if file_sr != sr:
            y = librosa.resample(y, orig_sr=file_sr, target_sr=sr)
        return y, sr
    finally:
        if tmp:
            wav.unlink(missing_ok=True)


def find_stems(stems_dir: Path | None, vocals: Path | None = None) -> dict[str, Path]:
    """Map separator labels to files. Drops 'other' when piano or guitar is real."""
    found: dict[str, Path] = {}
    if vocals is not None and vocals.exists():
        found["vocals"] = vocals
    if stems_dir and stems_dir.is_dir():
        for p in sorted(stems_dir.iterdir()):
            if not p.is_file() or p.suffix.lower() not in AUDIO_EXT:
                continue
            n = p.stem.lower()
            if "bounce" in n:
                continue
            for kind in ("vocals", "piano", "guitar", "bass", "drums", "other"):
                if kind in n:
                    found.setdefault(kind, p)
                    break
    if "piano" in found or "guitar" in found:
        found.pop("other", None)
    return found


def detect_tempo(y: np.ndarray, sr: int, hint: float | None) -> tuple[float, np.ndarray]:
    import librosa

    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    if isinstance(tempo, np.ndarray):
        tempo = float(tempo[0]) if tempo.size else 0.0
    tempo = float(tempo)
    if hint and 40 <= hint <= 220 and (tempo < 40 or abs(tempo - hint) > 25):
        if tempo >= 40:
            return round(tempo), beats
        return float(hint), beats
    if tempo < 40 or tempo > 220:
        return float(hint or 80), beats
    return round(tempo), beats


def vocal_onset_time(
    rms: np.ndarray,
    times: np.ndarray,
    min_run: float = 0.5,
    p90_frac: float = 0.15,
    intro: float = 3.0,
) -> float:
    """First time the vocal stem holds energy — skip separator bleed in the intro.

    Floor is the median of the first `intro` seconds; threshold is the larger of
    that floor × 8 and 15% of the file's 90th-percentile RMS. A 0.5s run above
    the threshold is the start of the sung line. Returns 0 when the stem is
    quiet throughout (karaoke / instrumental): callers then emit no melody.
    """
    if rms.size == 0 or times.size == 0:
        return 0.0
    intro_mask = times < intro
    floor = float(np.median(rms[intro_mask])) if np.any(intro_mask) else 0.0
    p90 = float(np.percentile(rms, 90))
    if p90 < 1e-5:
        return 0.0
    thr = max(p90 * p90_frac, floor * 8.0, 1e-4)
    hop = float(times[1] - times[0]) if len(times) > 1 else 0.01
    need = max(1, int(round(min_run / hop)))
    run = 0
    for i, v in enumerate(rms):
        if v >= thr:
            run += 1
            if run >= need:
                return float(times[i - need + 1])
        else:
            run = 0
    return 0.0


def frames_to_notes(
    times: np.ndarray,
    midi: np.ndarray,
    min_dur: float = 0.09,
) -> list[tuple[float, float, int]]:
    notes: list[tuple[float, float, int]] = []
    i, n = 0, len(midi)
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        pitch = int(np.clip(round(float(midi[i])), 24, 96))
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


def quantize(
    notes: list[tuple[float, float, int]],
    bpm: float,
    origin: float = 0.0,
) -> list[tuple[float, float, int]]:
    """Snap to 16ths measured from the first beat, not from t=0.

    A grid that starts at wall-clock zero drifts off the mix when the first
    downbeat is a few hundred milliseconds in (almost every writer MP3).
    """
    grid = 60.0 / bpm / 4  # 16th
    origin = float(origin)
    out: list[tuple[float, float, int]] = []
    for start, dur, pitch in notes:
        s = origin + round((start - origin) / grid) * grid
        d = max(grid, round(dur / grid) * grid)
        s = max(0.0, s)
        if out and abs(out[-1][2] - pitch) < 1 and s <= out[-1][0] + out[-1][1] + grid:
            ps, pd, pp = out[-1]
            out[-1] = (ps, max(pd, s + d - ps), pp)
        else:
            out.append((s, d, pitch))
    return out


def drop_before(notes: list[tuple[float, float, int]], t: float) -> list[tuple[float, float, int]]:
    if t <= 0:
        return notes
    return [(s, d, p) for s, d, p in notes if s + 0.02 >= t]


def drop_glides(
    notes: list[tuple[float, float, int]],
    max_dur: float = 0.12,
    max_gap: float = 0.15,
) -> list[tuple[float, float, int]]:
    """Drop pyin pitch-slides: a short note that immediately changes pitch."""
    out: list[tuple[float, float, int]] = []
    n = len(notes)
    for i, (s, d, p) in enumerate(notes):
        if d <= max_dur and i + 1 < n:
            ns, _, npitch = notes[i + 1]
            if abs(npitch - p) >= 1 and ns - (s + d) <= max_gap:
                continue
        out.append((s, d, p))
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


def _pyin_notes(
    y: np.ndarray,
    sr: int,
    fmin: str,
    fmax: str,
    min_dur: float,
    voiced_min: float | None = 0.5,
):
    import librosa

    f0, voiced, prob = librosa.pyin(
        y,
        fmin=librosa.note_to_hz(fmin),
        fmax=librosa.note_to_hz(fmax),
        sr=sr,
    )
    times = librosa.times_like(f0, sr=sr)
    # Piano/guitar/bass pyin confidence is much lower than a sung line. The
    # boolean `voiced` flag is enough there; a 0.5 cutoff wipes the intro.
    if voiced_min is None:
        keep = voiced
    else:
        keep = voiced & (np.nan_to_num(prob, nan=0.0) >= voiced_min)
    midi_f = np.where(keep, librosa.hz_to_midi(f0), np.nan)
    return frames_to_notes(times, midi_f, min_dur=min_dur)


def transcribe_pitched(
    y: np.ndarray,
    sr: int,
    kind: str,
    bpm: float,
    origin: float,
) -> list[tuple[float, float, int]]:
    fmin, fmax = RANGE[kind]
    min_dur = 0.12 if kind == "vocals" else 0.07
    raw = _pyin_notes(
        y, sr, fmin, fmax,
        min_dur=min_dur,
        voiced_min=0.5 if kind == "vocals" else None,
    )
    return quantize(drop_glides(raw), bpm, origin)


def transcribe_drums(
    y: np.ndarray,
    sr: int,
    bpm: float,
    origin: float,
) -> list[tuple[float, float, int]]:
    """Kick / snare / hat from onset band energy. Unpitched; pyin is the wrong tool."""
    import librosa

    env = librosa.onset.onset_strength(y=y, sr=sr)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time", backtrack=True)
    if len(onsets) == 0:
        return []
    S = np.abs(librosa.stft(y))
    freqs = librosa.fft_frequencies(sr=sr)
    times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr)
    env_t = librosa.times_like(env, sr=sr)
    thr = float(np.median(env) * 1.15)
    notes: list[tuple[float, float, int]] = []
    for t in onsets:
        e_i = int(np.argmin(np.abs(env_t - t)))
        if float(env[e_i]) < thr:
            continue
        i = int(np.argmin(np.abs(times - t)))
        frame = S[:, i]
        total = float(frame.sum()) + 1e-9
        low = float(frame[freqs < 120].sum())
        mid = float(frame[(freqs >= 120) & (freqs < 400)].sum())
        high = float(frame[freqs > 6000].sum())
        if low / total > 0.35:
            pitch = 36
        elif mid >= high:
            pitch = 38
        else:
            pitch = 42
        notes.append((float(t), 0.12, pitch))
    return quantize(notes, bpm, origin)


def write_midi(
    tracks: dict[str, list[tuple[float, float, int]]],
    bpm: float,
    dest: Path,
) -> int:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    n_notes = 0
    for kind, notes in tracks.items():
        if not notes:
            continue
        if kind == "drums":
            inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
        else:
            program, name = GM[kind]
            inst = pretty_midi.Instrument(program=program, name=name)
        for start, dur, pitch in notes:
            inst.notes.append(
                pretty_midi.Note(velocity=90, pitch=int(pitch), start=float(start), end=float(start + dur))
            )
        pm.instruments.append(inst)
        n_notes += len(notes)
    dest.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(dest))
    return n_notes


def write_musicxml(
    melody: list[tuple[float, float, int]],
    lyrics_path: Path,
    bpm: float,
    dest: Path,
) -> tuple[object, int]:
    from music21 import clef, key, meter, note, stream, tempo

    s = stream.Part()
    s.id = "P1"
    s.partName = "Melody"
    s.insert(0, clef.TrebleClef())
    s.insert(0, meter.TimeSignature("4/4"))
    s.insert(0, tempo.MetronomeMark(number=bpm))

    def to_ql(sec: float) -> float:
        return round((sec * bpm / 60.0) * 4) / 4

    def append_rest(ql_len: float) -> float:
        written = 0.0
        while ql_len - written >= 4:
            r = note.Rest()
            r.quarterLength = 4.0
            s.append(r)
            written += 4.0
        rem = round((ql_len - written) * 4) / 4
        if rem >= 0.25:
            r = note.Rest()
            r.quarterLength = rem
            s.append(r)
            written += rem
        return written

    if melody:
        offset_ql = 0.0
        for start, dur, pitch in melody:
            target = to_ql(start)
            gap = target - offset_ql
            if gap >= 0.25:
                offset_ql += append_rest(gap)
            n = note.Note(int(pitch))
            n.quarterLength = max(0.25, to_ql(dur))
            s.append(n)
            offset_ql += n.quarterLength
    else:
        append_rest(4.0)

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

    try:
        k = s.analyze("key")
    except Exception:
        k = key.Key("C")
    s.insert(0, key.Key(k.tonic.name, k.mode))
    score = stream.Score()
    score.insert(0, s)
    dest.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(dest))
    return k, len(melody_notes)


def transcribe(
    vocals: Path,
    lyrics_path: Path,
    out_dir: Path,
    bpm_hint: float | None = None,
    stems_dir: Path | None = None,
    mix: Path | None = None,
) -> dict:
    import librosa

    out_dir.mkdir(parents=True, exist_ok=True)
    stems = find_stems(stems_dir, vocals)
    if "vocals" not in stems:
        raise RuntimeError(f"no vocals stem in {vocals}")

    grid_src = mix if mix and mix.exists() else stems.get("drums") or stems["vocals"]
    y_grid, sr = load_mono(grid_src)
    bpm, beats = detect_tempo(y_grid, sr, bpm_hint)
    origin = float(beats[0]) if len(beats) else 0.0

    y_v, sr = load_mono(stems["vocals"])
    hop = 512
    v_rms = librosa.feature.rms(y=y_v, hop_length=hop)[0]
    v_times = librosa.times_like(v_rms, sr=sr, hop_length=hop)
    sung_at = vocal_onset_time(v_rms, v_times)

    tracks: dict[str, list[tuple[float, float, int]]] = {}
    for kind in PITCHED:
        path = stems.get(kind)
        if path is None:
            continue
        y = y_v if kind == "vocals" else load_mono(path)[0]
        notes = transcribe_pitched(y, sr, kind, bpm, origin)
        if kind == "vocals":
            if sung_at <= 0 and float(np.percentile(v_rms, 90)) < 1e-5:
                notes = []
            else:
                notes = drop_before(notes, sung_at)
        tracks[kind] = notes
    if "drums" in stems:
        y_d, _ = load_mono(stems["drums"])
        tracks["drums"] = transcribe_drums(y_d, sr, bpm, origin)

    melody = tracks.get("vocals") or tracks.get("piano") or tracks.get("guitar") or tracks.get("other") or []
    if not melody and not any(tracks.values()):
        raise RuntimeError(f"no pitched notes in {vocals.name}")

    mid_path = out_dir / "score.mid"
    xml_path = out_dir / "score.musicxml"
    k, n_melody = write_musicxml(melody, lyrics_path, bpm, xml_path)
    n_midi = write_midi(tracks, bpm, mid_path)
    sheet = _write_sheet(xml_path, out_dir)

    return {
        "bpm": bpm,
        "key": f"{k.tonic.name}{'m' if k.mode == 'minor' else ''}",
        "notes": n_melody,
        "midi_notes": n_midi,
        "vocal_onset": round(sung_at, 2),
        "grid_origin": round(origin, 3),
        "stems": sorted(tracks),
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
    ap.add_argument("--stems-dir", default=None)
    ap.add_argument("--mix", default=None)
    args = ap.parse_args()
    info = transcribe(
        Path(args.vocals),
        Path(args.lyrics),
        Path(args.out_dir),
        args.bpm,
        stems_dir=Path(args.stems_dir) if args.stems_dir else None,
        mix=Path(args.mix) if args.mix else None,
    )
    print(
        f"transcribed {info['notes']} melody notes, {info['midi_notes']} midi notes, "
        f"{info['key']} @ {info['bpm']} bpm, vocal@{info['vocal_onset']}s"
        f"{'' if info.get('sheet') else ' (no sheet renderer)'}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
