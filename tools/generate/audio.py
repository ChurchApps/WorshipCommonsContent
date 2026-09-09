"""Render piano/organ MP3s from MIDI, plus click tracks and 12-key pads.

Uses the site's FluidR3 midi-js soundfonts (MIT) mixed in numpy, then ffmpeg.
No fluidsynth required.

  python tools/generate/audio.py --root <content-root> [--only slug] [--skip-pads]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

SR = 22050
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
KEY_CHOICES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
PAD_FILE = {"C": "C", "Db": "Db", "D": "D", "Eb": "Eb", "E": "E", "F": "F", "F#": "Fs", "G": "G", "Ab": "Ab", "A": "A", "Bb": "Bb", "B": "B"}

SF_FILES = {
    "piano": "acoustic_grand_piano-mp3.js",
    "organ": "church_organ-mp3.js",
}


def midi_from_name(name: str) -> int | None:
    m = re.match(r"^([A-G])([#b]?)(-?\d+)$", name)
    if not m:
        return None
    letter, acc, octv = m.group(1), m.group(2), int(m.group(3))
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[letter]
    if acc == "#":
        base += 1
    elif acc == "b":
        base -= 1
    return (octv + 1) * 12 + base


def parse_soundfont_js(path: Path) -> dict[int, bytes]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    out = {}
    for name, b64 in re.findall(r'"([A-G][#b]?\-?\d+)": "data:audio/mp3;base64,([^"]+)"', text):
        n = midi_from_name(name)
        if n is None:
            continue
        import base64
        out[n] = base64.b64decode(b64)
    return out


def decode_mp3_bytes(mp3: bytes, cache_wav: Path) -> np.ndarray:
    if cache_wav.exists() and cache_wav.stat().st_size > 44:
        return wav_mono(cache_wav)
    cache_wav.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp.write(mp3)
        src = tmp.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", src,
             "-ac", "1", "-ar", str(SR), str(cache_wav)],
            check=True,
        )
    finally:
        os.unlink(src)
    return wav_mono(cache_wav)


def wav_mono(path: Path) -> np.ndarray:
    import wave
    with wave.open(str(path), "rb") as w:
        nch, sw, rate, nframes, *_ = w.getparams()
        raw = w.readframes(nframes)
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    else:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        data = (data - 128) / 128.0
    if nch > 1:
        data = data.reshape(-1, nch).mean(axis=1)
    if rate != SR:
        x = np.linspace(0, 1, len(data), endpoint=False)
        y = np.linspace(0, 1, int(len(data) * SR / rate), endpoint=False)
        data = np.interp(y, x, data).astype(np.float32)
    return data


def load_font(js_path: Path, cache_dir: Path) -> dict[int, np.ndarray]:
    samples = {}
    blob = parse_soundfont_js(js_path)
    for n, mp3 in blob.items():
        wav = cache_dir / f"{n}.wav"
        samples[n] = decode_mp3_bytes(mp3, wav)
    return samples


def parse_midi(path: Path):
    import mido
    mid = mido.MidiFile(str(path))
    tpb = mid.ticks_per_beat or 480
    tempo = 500000
    abs_tick = 0
    abs_sec = 0.0
    open_notes = {}
    notes = []
    for msg in mido.merge_tracks(mid.tracks):
        abs_tick += msg.time
        abs_sec += mido.tick2second(msg.time, tpb, tempo)
        if msg.type == "set_tempo":
            tempo = msg.tempo
        elif msg.type == "note_on" and msg.velocity > 0:
            open_notes.setdefault((msg.channel, msg.note), []).append((abs_sec, msg.velocity))
        elif msg.type in ("note_off", "note_on"):
            stack = open_notes.get((msg.channel, getattr(msg, "note", -1)))
            if stack:
                start, vel = stack.pop(0)
                notes.append((start, max(abs_sec - start, 0.05), msg.note, vel))
    return notes


def nearest_sample(samples: dict[int, np.ndarray], n: int) -> np.ndarray:
    if n in samples:
        return samples[n]
    keys = list(samples)
    if not keys:
        return np.zeros(SR, np.float32)
    k = min(keys, key=lambda x: abs(x - n))
    return samples[k]


def mix_midi(notes, samples: dict[int, np.ndarray], gain=0.28) -> np.ndarray:
    if not notes:
        return np.zeros(SR, np.float32)
    end = max(s + d for s, d, _, _ in notes) + 1.2
    out = np.zeros(int(end * SR) + SR, np.float32)
    for start, dur, n, vel in notes:
        samp = nearest_sample(samples, n)
        i0 = int(start * SR)
        # keep the natural decay; cap at note length + 400ms so SATB doesn't smear
        nlen = min(len(samp), int((dur + 0.4) * SR))
        i1 = min(i0 + nlen, len(out))
        sl = samp[: i1 - i0] * (gain * (vel / 127.0))
        # short fade at the cut so we don't click
        fade = min(int(0.02 * SR), len(sl) // 4 or 1)
        if fade:
            sl[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        out[i0:i1] += sl
    peak = float(np.max(np.abs(out))) or 1.0
    if peak > 0.95:
        out *= 0.95 / peak
    return out


def write_mp3(audio: np.ndarray, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(audio, -1, 1)
    pcm = (pcm * 32767).astype(np.int16)
    raw = dest.with_suffix(".wav")
    import wave
    with wave.open(str(raw), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw),
         "-codec:a", "libmp3lame", "-b:a", "96k", str(dest)],
        check=True,
    )
    raw.unlink(missing_ok=True)


def click_track(bpm: float, beats_per_bar: int, seconds: float) -> np.ndarray:
    bpm = max(40.0, min(float(bpm or 80), 200.0))
    beats_per_bar = max(1, int(beats_per_bar or 4))
    seconds = max(8.0, min(float(seconds or 60), 480.0))
    n = int(seconds * SR)
    out = np.zeros(n, np.float32)
    beat = 60.0 / bpm
    t = 0.0
    i = 0
    while t < seconds:
        start = int(t * SR)
        accent = (i % beats_per_bar) == 0
        freq = 1500 if accent else 1000
        amp = 0.5 if accent else 0.28
        length = int(0.03 * SR)
        tt = np.arange(length) / SR
        click = (np.sin(2 * np.pi * freq * tt) * np.exp(-tt * 80) * amp).astype(np.float32)
        end = min(start + length, n)
        out[start:end] += click[: end - start]
        t += beat
        i += 1
    return out


def pad_loop(root_pc: int, seconds=16.0) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    root = 110.0 * (2 ** (root_pc / 12))  # A2=110 is pc 9; shift so C= pc 0 → 130.81
    root = 130.8128 * (2 ** (root_pc / 12))
    fifth = root * 1.5
    octv = root * 2
    sub = root * 0.5
    wave = (
        0.22 * np.sin(2 * np.pi * sub * t)
        + 0.28 * np.sin(2 * np.pi * root * t)
        + 0.18 * np.sin(2 * np.pi * fifth * t)
        + 0.12 * np.sin(2 * np.pi * octv * t)
    )
    lfo = 0.85 + 0.15 * np.sin(2 * np.pi * t / 5)
    fade = np.minimum(np.minimum(t / 0.8, 1), np.minimum((seconds - t) / 0.8, 1))
    audio = (wave * lfo * fade * 0.35).astype(np.float32)
    return audio


def find_midis(root: Path, only: str | None):
    out = []
    for kind, base in (("work", root / "works"), ("song", root / "songs")):
        if not base.exists():
            continue
        for p in base.rglob("tune.mid"):
            if only and only not in str(p).replace("\\", "/"):
                continue
            deriv = p.parent.parent / "derivatives" if p.parent.name == "sources" else p.parent / "derivatives"
            out.append((p, deriv))
    return out


_SAMPLES = None

def _init_worker(sf_dir: str, cache: str):
    global _SAMPLES
    _SAMPLES = {kind: load_font(Path(sf_dir) / js, Path(cache) / kind) for kind, js in SF_FILES.items()}


def render_one(midi_path: str, deriv: str, sf_dir: str, cache: str, force: bool):
    global _SAMPLES
    midi = Path(midi_path)
    dest_dir = Path(deriv)
    piano_mp3 = dest_dir / "piano.mp3"
    organ_mp3 = dest_dir / "organ.mp3"
    if not force and piano_mp3.exists() and organ_mp3.exists() and piano_mp3.stat().st_mtime >= midi.stat().st_mtime:
        return "skip"
    if _SAMPLES is None:
        _init_worker(sf_dir, cache)
    notes = parse_midi(midi)
    dest_dir.mkdir(parents=True, exist_ok=True)
    write_mp3(mix_midi(notes, _SAMPLES["piano"]), piano_mp3)
    write_mp3(mix_midi(notes, _SAMPLES["organ"], gain=0.22), organ_mp3)
    return "ok"


def song_meta(dir: Path):
    p = dir / "masters" / "song.json"
    if not p.exists():
        p = dir / "song.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def duration_of(dir: Path, song: dict) -> float:
    dj = dir / "derivatives" / "duration.json"
    if dj.exists():
        try:
            sec = json.loads(dj.read_text(encoding="utf-8")).get("seconds")
            if sec:
                return float(sec)
        except Exception:
            pass
    return 90.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--site", required=True, help="WorshipCommons repo (soundfonts)")
    ap.add_argument("--only")
    ap.add_argument("--skip-pads", action="store_true")
    ap.add_argument("--skip-midi", action="store_true")
    ap.add_argument("--skip-click", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) - 1))
    args = ap.parse_args()
    root = Path(args.root)
    sf_dir = Path(args.site) / "public" / "soundfonts"
    cache = root / "tools" / ".cache" / "sf"

    # warm the sample cache in the parent so workers hit wav files
    if not args.skip_midi:
        print("audio: decoding soundfonts", flush=True)
        for kind, js in SF_FILES.items():
            load_font(sf_dir / js, cache / kind)

    stats = {"midi": 0, "skip": 0, "click": 0, "pads": 0, "fail": 0}

    if not args.skip_midi:
        jobs = find_midis(root, args.only)
        print(f"audio: {len(jobs)} MIDI files", flush=True)
        with ProcessPoolExecutor(max_workers=args.jobs, initializer=_init_worker, initargs=(str(sf_dir), str(cache))) as ex:
            futs = {
                ex.submit(render_one, str(midi), str(deriv), str(sf_dir), str(cache), args.force): midi
                for midi, deriv in jobs
            }
            for i, fut in enumerate(as_completed(futs), 1):
                midi = futs[fut]
                try:
                    r = fut.result()
                    stats["skip" if r == "skip" else "midi"] += 1
                except Exception as e:
                    stats["fail"] += 1
                    print(f" fail {midi}: {type(e).__name__} {e}", flush=True)
                if i % 25 == 0 or i == len(futs):
                    print(f"  midi {i}/{len(futs)}", flush=True)

    if not args.skip_click:
        songs_root = root / "songs"
        for song_json in songs_root.rglob("song.json"):
            if song_json.parent.name != "masters":
                continue
            d = song_json.parent.parent
            if args.only and args.only not in str(d).replace("\\", "/"):
                continue
            song = json.loads(song_json.read_text(encoding="utf-8"))
            dest = d / "derivatives" / "click.mp3"
            if not args.force and dest.exists():
                stats["click"] += 1
                continue
            ts = str(song.get("timeSignature") or "4/4")
            beats = int(ts.split("/")[0] or 4)
            audio = click_track(song.get("bpm") or 80, beats, duration_of(d, song))
            write_mp3(audio, dest)
            stats["click"] += 1

    if not args.skip_pads:
        pad_dir = root / "assets" / "pads"
        for i, name in enumerate(KEY_CHOICES):
            dest = pad_dir / f"{PAD_FILE[name]}.mp3"
            if not args.force and dest.exists():
                stats["pads"] += 1
                continue
            pc = midi_from_name(name + "4") % 12
            write_mp3(pad_loop(pc), dest)
            stats["pads"] += 1

    print("audio:", stats, flush=True)
    return 1 if stats["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
