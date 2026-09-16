"""Transcribe a granted mix to MIDI + MusicXML and underlay lyrics.chordpro.

  python tools/pack/stems_to_score.py <vocals.wav|.m4a> <lyrics.chordpro> <out_dir> [--bpm 80]
  python tools/pack/stems_to_score.py <vocals> <lyrics> <out_dir> --stems-dir <stems> --mix <master.mp3>

Writes out_dir/score.mid and out_dir/score.musicxml. Tries out_dir/lead-sheet.pdf
via MuseScore or Verovio when either is present.

score.mid is a sketch of the recording: pitched stems (vocals, piano, guitar,
bass, leftover other) through Basic Pitch (polyphonic; pyin fallback when it is
not installed) plus a simple drum track, retaining detected performance timing, with the mix's
intro left in place. `python tools/pack/stems_to_score.py --check <score.mid>
<stems_dir>` prints a per-track chroma / onset match against the stems.
MusicXML is still the melody + words (pyin, monophonic) — a person promotes it
to sources/score.musicxml after checking it. sources/tune.mid is someone
else's file and is never written here.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

SECTION = re.compile(
    r"^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus)\b",
    re.I,
)
AUDIO_EXT = {".wav", ".flac", ".m4a", ".mp3", ".aiff", ".aif", ".ogg", ".opus"}
PITCHED = ("vocals", "piano", "guitar", "bass", "other")
# Notes are (start, dur, pitch) or (start, dur, pitch, velocity).
SILENT_RMS = 0.003  # a separator stem below this is not in the mix
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

    tmp = path.suffix.lower() != ".wav"
    wav = path
    if tmp:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            wav = Path(f.name)
    try:
        if tmp:
            _ffmpeg_wav(path, wav)
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
    """Map separator labels to files. Silent stems are dropped later, by energy."""
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
    rms: np.ndarray | None = None,
) -> list[tuple]:
    """Runs of one pitch → notes. With `rms` (same frames) each note gets a velocity."""
    notes: list[tuple] = []
    vel_scale = float(np.percentile(rms, 95)) + 1e-9 if rms is not None else None
    i, n = 0, len(midi)
    hop = float(np.median(np.diff(times))) if n > 1 else 0.0
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        pitch = int(np.clip(round(float(midi[i])), 24, 96))
        j = i + 1
        while j < n and not np.isnan(midi[j]) and abs(float(midi[j]) - pitch) < 0.7:
            j += 1
        start = float(times[i])
        end = float(times[j]) if j < n else float(times[-1]) + hop
        dur = end - start
        if dur >= min_dur:
            if rms is None:
                notes.append((start, dur, pitch))
            else:
                v = float(rms[i:max(j, i + 1)].max()) / vel_scale
                notes.append((start, dur, pitch, int(np.clip(30 + 90 * v, 30, 120))))
        i = j
    return notes


def quantize(
    notes: list[tuple[float, float, int]],
    bpm: float,
    origin: float = 0.0,
    merge: bool = True,
    beats: np.ndarray | None = None,
) -> list[tuple[float, float, int]]:
    """Snap to 16ths on the tracked beats; without `beats`, a constant grid from `origin`.

    merge=False for drums: repeated hits on one pitch are hits, not one note.

    A constant grid drifts: a rounded 136 bpm against a 134.4 bpm performance
    slid 3 s over one song, and simultaneous hits on different stems snapped to
    different 16ths — a 110 ms flam between tracks. Subdividing the beats the
    tracker actually found follows the player.
    """
    grid = 60.0 / bpm / 4  # 16th
    origin = float(origin)
    if beats is not None and len(beats) > 1:
        pts = np.concatenate(
            [np.linspace(beats[i], beats[i + 1], 4, endpoint=False) for i in range(len(beats) - 1)]
            + [np.asarray(beats[-1:])]
        )
    else:
        pts = None
    out: list[tuple[float, float, int]] = []
    for start, dur, pitch, *vel in notes:
        if pts is not None and pts[0] <= start <= pts[-1]:
            s = float(pts[int(np.argmin(np.abs(pts - start)))])
        else:
            s = origin + round((start - origin) / grid) * grid
        d = max(grid, round(dur / grid) * grid)
        s = max(0.0, s)
        if merge and out and abs(out[-1][2] - pitch) < 1 and s <= out[-1][0] + out[-1][1] + grid:
            ps, pd, pp, *pv = out[-1]
            out[-1] = (ps, max(pd, s + d - ps), pp, *pv)
        else:
            out.append((s, d, pitch, *vel))
    return out


def playable_notes(notes: list[tuple], tick: float) -> list[tuple]:
    """Resolve same-key overlaps before MIDI note-off events become ambiguous.

    Work at the writer's tick resolution. Coincident detections become one note;
    a later attack releases the previous note first. Different pitches remain
    polyphonic, and real repeated attacks retain their own velocities.
    """
    by_pitch: dict[int, list[tuple]] = {}
    for start, dur, pitch, *velocity in notes:
        if not np.isfinite(start) or not np.isfinite(dur) or dur <= 0:
            continue
        a = max(0, round(start / tick))
        b = max(a + 1, round((start + dur) / tick))
        by_pitch.setdefault(int(pitch), []).append((a, b, velocity[0] if velocity else 90))
    out = []
    for pitch, events in by_pitch.items():
        clean = []
        for a, b, velocity in sorted(events):
            if clean and a == clean[-1][0]:
                pa, pb, pv = clean[-1]
                clean[-1] = (pa, max(pb, b), max(pv, velocity))
                continue
            if clean and clean[-1][1] > a:
                pa, _, pv = clean[-1]
                clean[-1] = (pa, a, pv)
            clean.append((a, b, velocity))
        out.extend((a * tick, (b - a) * tick, pitch, velocity) for a, b, velocity in clean)
    return sorted(out)


def gate_quiet(
    notes: list[tuple],
    rms: np.ndarray,
    times: np.ndarray,
    frac: float = 0.08,
) -> list[tuple]:
    """Drop notes where the stem itself is near silent (-22 dB under its loud level).

    pyin and Basic Pitch both hear pitches in separator noise: a silent bass
    stem gave ten wrong bass notes in one intro.
    """
    if rms.size == 0 or not notes:
        return notes
    thr = float(np.percentile(rms, 95)) * frac
    return [n for n in notes if rms[min(int(np.searchsorted(times, n[0])), rms.size - 1)] >= thr]


def drop_doubles(notes: list[tuple], against: list[tuple]) -> list[tuple]:
    """Drop notes already sounding at the same pitch in `against` (separator bleed)."""
    if not notes or not against:
        return notes
    by_pitch: dict[int, list[tuple[float, float]]] = {}
    for st, d, pch, *_ in against:
        by_pitch.setdefault(int(pch), []).append((st, st + d))
    out = []
    for n in notes:
        st, d, pch = n[0], n[1], int(n[2])
        if any(a < st + d and st < b for a, b in by_pitch.get(pch, ())):
            continue
        out.append(n)
    return out


def drop_before(notes: list[tuple[float, float, int]], t: float) -> list[tuple[float, float, int]]:
    if t <= 0:
        return notes
    return [n for n in notes if n[0] + 0.02 >= t]


def drop_glides(
    notes: list[tuple[float, float, int]],
    max_dur: float = 0.12,
    max_gap: float = 0.15,
) -> list[tuple[float, float, int]]:
    """Drop pyin pitch-slides: a short note that immediately changes pitch."""
    out: list[tuple[float, float, int]] = []
    n = len(notes)
    for i, note in enumerate(notes):
        s, d, p = note[:3]
        if d <= max_dur and i + 1 < n:
            ns, _, npitch = notes[i + 1][:3]
            if abs(npitch - p) >= 1 and ns - (s + d) <= max_gap:
                continue
        out.append(note)
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
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0][: len(midi_f)]
    return frames_to_notes(times, midi_f, min_dur=min_dur, rms=rms)


_BP_MODEL = None


def _basic_pitch_notes(
    y: np.ndarray,
    sr: int,
    fmin: str,
    fmax: str,
    min_dur: float,
) -> list[tuple[float, float, int]] | None:
    """Polyphonic notes via Spotify Basic Pitch (ONNX). None when not installed.

    pyin is monophonic: on a piano or pad stem it returns one jumping pitch per
    frame and the track sounds like nothing. Basic Pitch hears the chords.
    """
    global _BP_MODEL
    try:
        import librosa
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model, predict
    except ImportError:
        return None
    if _BP_MODEL is None:
        _BP_MODEL = Model(ICASSP_2022_MODEL_PATH)
    wav = _as_wav(y, sr)
    try:
        _, mid, _ = predict(
            wav,
            _BP_MODEL,
            onset_threshold=0.5,
            frame_threshold=0.3,
            minimum_note_length=min_dur * 1000,
            minimum_frequency=float(librosa.note_to_hz(fmin)),
            maximum_frequency=float(librosa.note_to_hz(fmax)),
            melodia_trick=True,
        )
    finally:
        Path(wav).unlink(missing_ok=True)
    notes = [(n.start, n.end - n.start, n.pitch, n.velocity) for i in mid.instruments for n in i.notes]
    return sorted(notes)


def _as_wav(y: np.ndarray, sr: int) -> str:
    """Basic Pitch wants a path, not an array."""
    import tempfile

    import soundfile

    f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    f.close()
    soundfile.write(f.name, y, sr)
    return f.name


def transcribe_pitched(
    y: np.ndarray,
    sr: int,
    kind: str,
    bpm: float,
    origin: float,
    beats: np.ndarray | None = None,
) -> list[tuple[float, float, int]]:
    fmin, fmax = RANGE[kind]
    min_dur = 0.12 if kind == "vocals" else 0.07
    # Bass is one line; pyin holds its register where Basic Pitch jumps octaves.
    raw = None if kind == "bass" else _basic_pitch_notes(y, sr, fmin, fmax, min_dur)
    if raw is not None:
        # Playback follows the performance. Quantization belongs to notation:
        # independent start/duration rounding damages reattacks and arpeggios.
        return raw
    return melody_line(y, sr, kind, bpm, origin, beats, snap=False)


def melody_line(
    y: np.ndarray,
    sr: int,
    kind: str,
    bpm: float,
    origin: float,
    beats: np.ndarray | None = None,
    snap: bool = True,
) -> list[tuple[float, float, int]]:
    """One monophonic line (pyin) — what the MusicXML lyric underlay needs."""
    fmin, fmax = RANGE[kind]
    min_dur = 0.12 if kind == "vocals" else 0.07
    raw = _pyin_notes(
        y, sr, fmin, fmax,
        min_dur=min_dur,
        voiced_min=0.5 if kind == "vocals" else None,
    )
    notes = drop_glides(raw)
    return quantize(notes, bpm, origin, beats=beats) if snap else notes


def transcribe_drums(
    y: np.ndarray,
    sr: int,
    bpm: float,
    origin: float,
    beats: np.ndarray | None = None,
) -> list[tuple[float, float, int]]:
    """Kick / snare / hat from onset band energy. Unpitched; pyin is the wrong tool."""
    import librosa

    env = librosa.onset.onset_strength(y=y, sr=sr)
    # No backtrack: it moves each onset to the preceding energy minimum, and the
    # threshold below then reads that minimum and throws the hit away.
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time")
    if len(onsets) == 0:
        return []
    S = np.abs(librosa.stft(y))
    freqs = librosa.fft_frequencies(sr=sr)
    times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr)
    env_t = librosa.times_like(env, sr=sr)
    thr = float(np.median(env) * 1.15)
    loud = float(np.percentile(env, 95)) + 1e-9
    notes: list[tuple] = []
    for t in onsets:
        e_i = int(np.argmin(np.abs(env_t - t)))
        if float(env[e_i]) < thr:
            continue
        vel = int(np.clip(40 + 80 * float(env[e_i]) / loud, 40, 120))
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
        notes.append((float(t), 0.12, pitch, vel))
    return notes


def write_midi(
    tracks: dict[str, list[tuple[float, float, int]]],
    bpm: float,
    dest: Path,
) -> int:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm, resolution=960)
    tick = 60.0 / bpm / pm.resolution
    n_notes = 0
    for kind, notes in tracks.items():
        notes = playable_notes(notes, tick)
        if not notes:
            continue
        if kind == "drums":
            inst = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
        else:
            program, name = GM[kind]
            inst = pretty_midi.Instrument(program=program, name=name)
        for start, dur, pitch, *vel in notes:
            inst.notes.append(
                pretty_midi.Note(
                    velocity=int(vel[0]) if vel else 90,
                    pitch=int(pitch), start=float(start), end=float(start + dur),
                )
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
        for start, dur, pitch, *_ in melody:
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

    silent_vocals = sung_at <= 0 and float(np.percentile(v_rms, 90)) < 1e-5
    tracks: dict[str, list[tuple[float, float, int]]] = {}
    for kind in PITCHED:
        path = stems.get(kind)
        if path is None:
            continue
        y = y_v if kind == "vocals" else load_mono(path)[0]
        if float(np.sqrt(np.mean(y**2))) < SILENT_RMS:
            continue
        notes = transcribe_pitched(y, sr, kind, bpm, origin, beats)
        rms = v_rms if kind == "vocals" else librosa.feature.rms(y=y, hop_length=hop)[0]
        notes = gate_quiet(notes, rms, librosa.times_like(rms, sr=sr, hop_length=hop))
        if kind == "vocals":
            notes = [] if silent_vocals else drop_before(notes, sung_at)
        if kind == "other":  # MelBand leftover doubles piano/guitar where they play
            for src in ("piano", "guitar"):
                notes = drop_doubles(notes, tracks.get(src, []))
        tracks[kind] = notes
    vocal_line = [] if silent_vocals else drop_before(melody_line(y_v, sr, "vocals", bpm, origin, beats), sung_at)
    if "drums" in stems:
        y_d, _ = load_mono(stems["drums"])
        if float(np.sqrt(np.mean(y_d**2))) >= SILENT_RMS:
            tracks["drums"] = transcribe_drums(y_d, sr, bpm, origin, beats)

    melody = vocal_line or tracks.get("piano") or tracks.get("guitar") or tracks.get("other") or []
    if not melody and not any(tracks.values()):
        raise RuntimeError(f"no pitched notes in {vocals.name}")

    mid_path = out_dir / "score.mid"
    xml_path = out_dir / "score.musicxml"
    k, n_melody = write_musicxml(melody, lyrics_path, bpm, xml_path)
    n_midi = write_midi(tracks, bpm, mid_path)
    sheet = _write_sheet(xml_path, out_dir)

    return {
        "bpm": bpm,
        "key": f"{k.tonic.name.replace('-', 'b')}{'m' if k.mode == 'minor' else ''}",  # Eb, as the catalog spells it
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


def check(mid: Path, stems_dir: Path, seconds: float | None = None) -> dict[str, dict]:
    """Per-track match of score.mid against the stems it came from.

    Each track is rendered with a throwaway additive synth and compared to its
    stem: chroma cosine similarity over frames where the stem is audible
    (pitched tracks) and onset F1 within 70 ms (all tracks). Chroma ignores
    octave and articulation errors, so it is not a listening-quality score.
    Use seconds to inspect an opening passage rather than a whole-song average.
    """
    import librosa
    import pretty_midi

    sr = 22050
    name2stem = {name: kind for kind, (_, name) in GM.items()} | {"Drums": "drums"}
    stems = find_stems(stems_dir)
    hop = 2048

    def synth(inst, n: int) -> np.ndarray:
        y = np.zeros(n + sr, np.float32)
        for note in inst.notes:
            a, b = int(note.start * sr), min(int(note.end * sr), len(y))
            if b <= a:
                continue
            t = np.arange(b - a) / sr
            f = 440.0 * 2 ** ((note.pitch - 69) / 12)
            env = np.exp(-40 * t) if inst.is_drum else np.exp(-3 * t / max(note.end - note.start, 0.05))
            y[a:b] += (0.5 * np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)) * env
        return y[:n]

    def onset_f1(a: np.ndarray, b: np.ndarray) -> float:
        oa = librosa.onset.onset_detect(y=a, sr=sr, units="time")
        ob = librosa.onset.onset_detect(y=b, sr=sr, units="time")
        if not len(oa) or not len(ob):
            return 0.0
        p = np.mean([np.min(np.abs(ob - t)) < 0.07 for t in oa])
        r = np.mean([np.min(np.abs(oa - t)) < 0.07 for t in ob])
        return float(2 * p * r / (p + r + 1e-9))

    out: dict[str, dict[str, float]] = {}
    for inst in pretty_midi.PrettyMIDI(str(mid)).instruments:
        path = stems.get(name2stem.get(inst.name, ""))
        if path is None:
            continue
        ys, _ = load_mono(path, sr)
        if seconds is not None:
            ys = ys[:max(1, int(seconds * sr))]
            inst.notes = [n for n in inst.notes if n.start < seconds]
        if not inst.notes:
            out[inst.name] = {"notes": 0}
            continue
        ym = synth(inst, len(ys))
        row = {"notes": len(inst.notes), "onset_f1": round(onset_f1(ym, ys), 2)}
        ordered = sorted(inst.notes, key=lambda n: n.start)
        ends: dict[int, float] = {}
        overlaps = 0
        for n in ordered:
            overlaps += n.start < ends.get(n.pitch, -1) - 1e-6
            ends[n.pitch] = max(n.end, ends.get(n.pitch, -1))
        row["same_pitch_overlaps"] = overlaps
        row["notes_under_30ms"] = sum(n.end - n.start < .03 for n in ordered)
        if not inst.is_drum:
            ca = librosa.feature.chroma_cqt(y=ym, sr=sr, hop_length=hop)
            cb = librosa.feature.chroma_cqt(y=ys, sr=sr, hop_length=hop)
            cos = (ca * cb).sum(0) / (np.linalg.norm(ca, axis=0) * np.linalg.norm(cb, axis=0) + 1e-9)
            audible = (librosa.feature.rms(y=ys, hop_length=hop)[0] > 0.01)[: len(cos)]
            row["chroma"] = round(float(cos[audible].mean()), 2) if audible.any() else float("nan")
            # chroma is octave-blind; register catches a bass line written an octave up
            # pyin only means something on a one-line stem (bass, melody); on a
            # piano it locks onto the lowest partial and reads ~20 semitones low.
            span = sum(n.end - n.start for n in inst.notes) / max(inst.get_end_time(), 1e-9)
            f0, voiced, _ = librosa.pyin(ys, fmin=40, fmax=1500, sr=sr) if span < 1.5 else (None, np.zeros(1, bool), None)
            if voiced.any() and inst.notes:
                stem_med = float(np.median(librosa.hz_to_midi(f0[voiced])))
                row["register"] = round(float(np.median([n.pitch for n in inst.notes])) - stem_med, 1)
            row["vel"] = f"{min(n.velocity for n in inst.notes)}-{max(n.velocity for n in inst.notes)}"
        out[inst.name] = row
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vocals", help="vocals stem, or score.mid with --check")
    ap.add_argument("lyrics", help="lyrics.chordpro, or stems dir with --check")
    ap.add_argument("out_dir", nargs="?")
    ap.add_argument("--check", action="store_true", help="score an existing score.mid against its stems")
    ap.add_argument("--seconds", type=float, help="limit --check to the opening N seconds")
    ap.add_argument("--bpm", type=float, default=None)
    ap.add_argument("--stems-dir", default=None)
    ap.add_argument("--mix", default=None)
    args = ap.parse_args()
    if args.seconds is not None and (not np.isfinite(args.seconds) or args.seconds <= 0 or not args.check):
        ap.error("--seconds requires --check and a positive finite duration")
    if args.check:
        for name, row in check(Path(args.vocals), Path(args.lyrics), args.seconds).items():
            print(f"{name:7s} " + "  ".join(f"{k}={v}" for k, v in row.items()))
        return 0
    if not args.out_dir:
        ap.error("out_dir is required")
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
