#!/usr/bin/env python3
"""Build a rehearsal stems pack (Ableton Live session + audio) from MusicXML.

  {Title}-{Title}-{Key}-{BPM}bpm/
    Album.jpg
    Session.als             (gzipped Ableton Live 8.4.2 set)
    Ableton Project Info/   (Project8_1.cfg)
    Stems/*.m4a             (stereo 44.1 kHz, equal length; --format for ogg/flac/wav)

MusicXML = what is played. production.json = how it should sound (amp/FX/mix).
arrangement.json = source mix, form/cues, count-off. Rendered sound is Stems/*.

Also writes a listening mix with no click, guide-as-cue, or count-off:
  Full Mix.m4a                  (inside the pack folder)
  {folder}-fullmix.m4a          (next to the zip)
  preview.m4a                   30 s site preview
  instrumental.m4a              full mix minus vocal stems, when a vocal stem exists

  python generate_multitracks.py
  python generate_multitracks.py --midi-only
  python generate_multitracks.py --from-stems
"""
from __future__ import annotations

import argparse
import base64
import copy
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import warnings
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")

SR = 44100
COUNT_OFF_BARS = 2
# What the pack calls its audio folder and session. Deliberately not "MultiTracks":
# that is a company, and this is not their product.
STEMS_DIR = "Stems"
SESSION = "Session.als"
# Live reads WAV/AIFF/FLAC/OGG natively; MP3/M4A go through an external codec and
# Ableton documents M4A as unreliable on Windows. ogg is the small native option.
FORMATS = {"m4a": ["-c:a", "aac", "-b:a", "320k", "-profile:a", "aac_low", "-movflags", "+faststart"],
           "ogg": ["-c:a", "libvorbis", "-q:a", "6"],
           "flac": ["-c:a", "flac", "-compression_level", "8"],
           "wav": ["-c:a", "pcm_s16le"]}
B_MAJOR_PC = {11, 1, 3, 4, 6, 8, 10}

SCRIPT_DIR = Path(__file__).resolve().parent
# MT_ROOT points this at one song package's work dir (see build.py). Unset = run in place.
HERE = Path(os.environ.get("MT_ROOT") or SCRIPT_DIR)
ASSETS = Path(os.environ.get("MT_ASSETS") or (SCRIPT_DIR / "assets"))
CACHE = HERE / "_mt_cache"
SF_DIR = Path(os.environ.get("MT_SF_DIR") or (CACHE / "sf"))
SF_HQ = Path(os.environ.get("MT_SF_HQ") or (CACHE / "sf_fatboy"))
_asset = lambda name: (ASSETS / name) if (ASSETS / name).exists() else (CACHE / name)
ALS_TEMPLATE = _asset("session-skeleton.als.xml")
ALBUM_SRC = Path(os.environ["MT_ALBUM"]) if os.environ.get("MT_ALBUM") else CACHE / "album_source.jpg"
ABLETON_INFO = _asset("Ableton Project Info")
ARRANGEMENT = HERE / "masters" / "arrangement.json"
PRODUCTION = HERE / "masters" / "production.json"

MIDI_RENDER_AS = {
    "midi:click": "Click Track",
    "midi:guide": "Guide",
    "midi:drums": "Drums",
    "midi:bass": "Bass",
    "midi:synthbass": "Synth Bass",
    "midi:eg1": "EG 1",
    "midi:eg2": "EG 2",
    "midi:ag": "AG Group",
    "midi:piano": "Piano",
    "midi:keys1": "Keys 1",
    "midi:keys2": "Keys 2",
    "midi:strings": "Strings",
    "midi:choir": "Choir 1",
    "midi:bgvs": "BGVS",
    "midi:fx": "FX",
    "midi:tamb": "Tambourine",
}

STEMS = [
    # name, color (from reference pack), pan (-1..1), mix gain into preview
    ("Click Track", 199, 0.00, 0.18),
    ("Guide", 199, 0.00, 0.55),
    ("Drums", 152, 0.00, 0.85),
    ("FX", 152, 0.00, 0.35),
    ("Tambourine", 0, 0.45, 0.28),
    ("Bass", 142, 0.00, 0.80),
    ("Synth Bass", 142, 0.00, 0.45),
    ("AG Group", 0, -0.28, 0.55),
    ("EG 1", 159, 0.22, 0.50),
    ("EG 2", 159, -0.18, 0.42),
    ("Piano", 156, -0.08, 0.62),
    ("Keys 1", 156, 0.30, 0.40),
    ("Keys 2", 156, -0.22, 0.32),
    ("Strings", 156, 0.00, 0.38),
    ("BGVS", 177, 0.12, 0.42),
    ("Choir 1", 177, 0.00, 0.36),
]

# MIDI-only mix: lead guitar is the recorded hook; click stays out of Full Mix.
MIDI_MIX_GAIN = {
    "Click Track": 0.0,
    "Guide": 0.42,
    "Drums": 0.78,
    "FX": 0.22,
    "Tambourine": 0.22,
    "Bass": 0.74,
    "Synth Bass": 0.0,
    "AG Group": 0.32,
    "EG 1": 0.92,
    "EG 2": 0.38,
    "Piano": 0.48,
    "Keys 1": 0.36,
    "Keys 2": 0.22,
    "Strings": 0.28,
    "BGVS": 0.32,
    "Choir 1": 0.26,
}
MIDI_STEM_FX = {
    "EG 1": [
        {"type": "highpass", "hz": 90},
        {"type": "drive", "amount": 0.38},
        {"type": "delay", "beats": 0.75, "mix": 0.30, "feedback": 0.32},
    ],
    "EG 2": [
        {"type": "highpass", "hz": 110},
        {"type": "drive", "amount": 0.22},
    ],
    "Keys 1": [{"type": "reverb", "mix": 0.30, "delayMs": 58}],
    "Strings": [{"type": "reverb", "mix": 0.34, "delayMs": 70}],
    "Choir 1": [{"type": "reverb", "mix": 0.32, "delayMs": 64}],
    "BGVS": [{"type": "reverb", "mix": 0.22, "delayMs": 48}],
    "Guide": [{"type": "reverb", "mix": 0.18, "delayMs": 40}],
}

SF_FOR = {
    "Guide": "voice_oohs",
    "Bass": "electric_bass_finger",
    "Synth Bass": "synth_bass_1",
    "AG Group": "acoustic_guitar_steel",
    "EG 1": "overdriven_guitar",
    "EG 2": "distortion_guitar",
    "Piano": "acoustic_grand_piano",
    "Keys 1": "pad_2_warm",
    "Keys 2": "electric_piano_1",
    "Strings": "string_ensemble_1",
    "BGVS": "choir_aahs",
    "Choir 1": "choir_aahs",
}

GUITAR_VOICINGS = {
    "B": [47, 54, 59, 63, 66],
    "B/D#": [51, 54, 59, 63, 66],
    "B/F#": [42, 47, 54, 59, 63],
    "E": [40, 47, 52, 56, 59],
    "C#m": [49, 52, 56, 61, 64],
    "F#": [42, 49, 54, 58, 61],
}

PAD_VOICINGS = {
    "B": [59, 63, 66, 71],
    "B/D#": [51, 59, 63, 66],
    "B/F#": [54, 59, 63, 66],
    "E": [52, 59, 64, 68],
    "C#m": [49, 52, 56, 61, 64],
    "F#": [54, 58, 61, 66],
}


@dataclass
class Note:
    start: float
    dur: float
    midi: int
    vel: int
    strum: float = 0.0  # delay seconds (for guitar rolls)


@dataclass
class Hit:
    start: float
    kind: str
    vel: float = 1.0


@dataclass
class ChordSpan:
    ql: float
    dur: float
    figure: str
    root: int
    bass: int
    pitches: list[int]


@dataclass
class Section:
    name: str
    locator: str
    start_ql: float
    end_ql: float
    energy: int


@dataclass
class Score:
    title: str
    key: str
    bpm: float
    beats_per_bar: int
    n_bars: int
    sections: list[Section]
    chords: list[ChordSpan]
    melody: list[tuple[float, float, int, int, bool]]  # ql, dur, midi, vel, lyric
    piano: list[tuple[float, float, int, int]]
    guitar: list[tuple[float, float, int, int]] = field(default_factory=list)
    bass_notes: list[tuple[float, float, int, int]] = field(default_factory=list)
    drum_hits: list[tuple[float, str, float]] = field(default_factory=list)
    count_off_beats: int = COUNT_OFF_BARS * 4

    @property
    def total_beats(self) -> float:
        return self.count_off_beats + self.n_bars * self.beats_per_bar

    @property
    def total_seconds(self) -> float:
        return self.total_beats * 60.0 / self.bpm + 0.25

    def sec(self, ql: float) -> float:
        return (self.count_off_beats + ql) * 60.0 / self.bpm

    def section_at(self, ql: float) -> Section:
        for s in self.sections:
            if s.start_ql <= ql < s.end_ql - 1e-6:
                return s
        return self.sections[-1]


# ---------------------------------------------------------------------------
# Soundfonts
# ---------------------------------------------------------------------------
_NOTE_RE = re.compile(r'"([A-G])([#b]?)(-?\d+)": "data:audio/mp3;base64,([^"]+)"')


def midi_from_name(letter: str, acc: str, octv: int) -> int:
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[letter]
    if acc == "#":
        base += 1
    elif acc == "b":
        base -= 1
    return (octv + 1) * 12 + base


def parse_sf_js(path: Path) -> dict[int, bytes]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    out = {}
    for letter, acc, octv, b64 in _NOTE_RE.findall(text):
        out[midi_from_name(letter, acc, int(octv))] = base64.b64decode(b64)
    return out


def wav_mono(path: Path) -> np.ndarray:
    import soundfile as sf

    data, rate = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if rate != SR:
        x = np.linspace(0, 1, len(data), endpoint=False)
        y = np.linspace(0, 1, int(len(data) * SR / rate), endpoint=False)
        data = np.interp(y, x, data).astype(np.float32)
    return data


def decode_mp3(mp3: bytes, cache_wav: Path) -> np.ndarray:
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


def load_font(name: str, needed: set[int]) -> dict[int, np.ndarray]:
    hq = SF_HQ / f"{name}-mp3.js"
    if hq.exists():
        js, cache = hq, CACHE / "wav" / f"fatboy_{name}"
    else:
        js = SF_DIR / f"{name}-mp3.js"
        cache = CACHE / "wav" / name
    if not js.exists():
        raise FileNotFoundError(js)
    blob = parse_sf_js(js)
    keys = sorted(blob)
    want = set()
    for n in needed:
        if n in blob:
            want.add(n)
        elif keys:
            want.add(min(keys, key=lambda k: abs(k - n)))
    samples: dict[int, np.ndarray] = {}

    def one(k: int):
        return k, decode_mp3(blob[k], cache / f"{k}.wav")

    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(one, k) for k in sorted(want)]
        for fut in as_completed(futs):
            k, arr = fut.result()
            samples[k] = arr
    return samples


def nearest(samples: dict[int, np.ndarray], n: int) -> tuple[int, np.ndarray]:
    if n in samples:
        return n, samples[n]
    k = min(samples, key=lambda x: abs(x - n))
    return k, samples[k]


def pitched(samp: np.ndarray, src: int, dest: int) -> np.ndarray:
    if src == dest:
        return samp
    ratio = 2 ** ((dest - src) / 12.0)
    new_len = max(16, int(len(samp) / ratio))
    x = np.arange(len(samp), dtype=np.float32)
    y = np.linspace(0, len(samp) - 1, new_len, dtype=np.float32)
    return np.interp(y, x, samp).astype(np.float32)


# ---------------------------------------------------------------------------
# DSP
# ---------------------------------------------------------------------------
def equal_power(pan: float) -> tuple[float, float]:
    a = (np.clip(pan, -1, 1) + 1) * (np.pi / 4)
    return float(np.cos(a)), float(np.sin(a))


def mix_notes(
    notes: list[Note],
    samples: dict[int, np.ndarray],
    n: int,
    pan: float = 0.0,
    gain: float = 0.28,
    release: float = 0.35,
) -> np.ndarray:
    out = np.zeros((n, 2), np.float32)
    if not notes or not samples:
        return out
    gl, gr = equal_power(pan)
    for nt in notes:
        src, samp = nearest(samples, nt.midi)
        samp = pitched(samp, src, nt.midi)
        t0 = nt.start + nt.strum
        i0 = int(t0 * SR)
        if i0 >= n:
            continue
        nlen = min(len(samp), int((nt.dur + release) * SR))
        i1 = min(i0 + nlen, n)
        sl = samp[: i1 - i0] * (gain * (nt.vel / 127.0))
        fade = min(int(0.012 * SR), max(1, len(sl) // 6))
        sl = sl.copy()
        sl[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        attack = min(int(0.004 * SR), max(1, len(sl) // 8))
        sl[:attack] *= np.linspace(0, 1, attack, dtype=np.float32)
        out[i0:i1, 0] += sl * gl
        out[i0:i1, 1] += sl * gr
    return out


def cheap_reverb(x: np.ndarray, mix: float = 0.16, delay_ms: float = 42, decay: float = 0.28) -> np.ndarray:
    if mix <= 0:
        return x
    d = int(delay_ms * SR / 1000)
    y = x.copy()
    if d < len(x):
        y[d:] += decay * x[:-d]
        y[d:, 0] += decay * 0.45 * x[:-d, 1]
        y[d:, 1] += decay * 0.45 * x[:-d, 0]
        d2 = d * 2 + 11
        if d2 < len(x):
            y[d2:] += decay * 0.4 * x[:-d2]
    return ((1 - mix) * x + mix * y).astype(np.float32)


PREVIEW_SECONDS = 30


def limit(x: np.ndarray, peak: float = 0.95) -> np.ndarray:
    m = float(np.max(np.abs(x))) if x.size else 0.0
    if m > peak:
        x = x * (peak / m)
    return x.astype(np.float32)


def write_wav(path: Path, audio: np.ndarray):
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(audio, -1, 1), SR, subtype="PCM_16")


def peak_normalize(x: np.ndarray, target: float = 0.72, floor: float = 1e-4) -> np.ndarray:
    m = float(np.max(np.abs(x))) if x.size else 0.0
    if m < floor:
        return x.astype(np.float32)
    return (x * (target / m)).astype(np.float32)


def encode_m4a(wav: Path, dest: Path, fmt: str = "m4a"):
    if fmt == "m4a":
        # Prefer MediaFoundation AAC (CBR-ish, closer to the Nero 320k reference).
        r = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(wav), "-ar", str(SR), "-ac", "2",
             "-c:a", "aac_mf", "-b:a", "320k", "-movflags", "+faststart", str(dest)],
            capture_output=True, text=True)
        if r.returncode == 0:
            return
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(wav),
         "-ar", str(SR), "-ac", "2", *FORMATS[fmt], str(dest)],
        check=True,
    )


# ---------------------------------------------------------------------------
# Synthesized kit (click, drums, tambourine, FX)
# ---------------------------------------------------------------------------
def _exp(t, k):
    return np.exp(-t * k).astype(np.float32)


def make_kick() -> np.ndarray:
    t = np.arange(int(0.48 * SR)) / SR
    freq = 190 * np.exp(-t * 24) + 36
    body = np.sin(np.cumsum(2 * np.pi * freq / SR)) * _exp(t, 6.2)
    sub = np.sin(2 * np.pi * 42 * t) * _exp(t, 4.8) * 0.55
    click = np.sin(2 * np.pi * 3200 * t) * _exp(t, 75) * 0.42
    return np.clip(body + sub + click, -1, 1).astype(np.float32)


def make_snare() -> np.ndarray:
    rng = np.random.default_rng(2)
    t = np.arange(int(0.32 * SR)) / SR
    tone = (np.sin(2 * np.pi * 185 * t) + 0.4 * np.sin(2 * np.pi * 330 * t)) * _exp(t, 18)
    noise = rng.standard_normal(len(t)).astype(np.float32)
    kernel = np.ones(8, np.float32) / 8
    noise = noise - np.convolve(noise, kernel, mode="same")
    noise *= _exp(t, 16)
    return (0.38 * tone + 0.72 * noise).astype(np.float32) * 0.85


def make_hat(open_=False) -> np.ndarray:
    rng = np.random.default_rng(7 if open_ else 3)
    dur = 0.28 if open_ else 0.055
    t = np.arange(int(dur * SR)) / SR
    noise = rng.standard_normal(len(t)).astype(np.float32)
    # crude highpass
    noise = np.diff(noise, prepend=noise[:1])
    k = 14 if open_ else 55
    return (noise * _exp(t, k) * (0.45 if open_ else 0.32)).astype(np.float32)


def make_crash() -> np.ndarray:
    rng = np.random.default_rng(11)
    t = np.arange(int(1.6 * SR)) / SR
    noise = rng.standard_normal(len(t)).astype(np.float32)
    noise = np.diff(noise, prepend=noise[:1])
    metal = np.sin(2 * np.pi * 540 * t) * 0.08 + np.sin(2 * np.pi * 810 * t) * 0.05
    return ((noise * 0.55 + metal) * _exp(t, 2.2)).astype(np.float32)


def make_tom(f0: float) -> np.ndarray:
    t = np.arange(int(0.38 * SR)) / SR
    freq = f0 * np.exp(-t * 6) + f0 * 0.35
    return (np.sin(np.cumsum(2 * np.pi * freq / SR)) * _exp(t, 9)).astype(np.float32) * 0.7


def make_tamb() -> np.ndarray:
    rng = np.random.default_rng(19)
    t = np.arange(int(0.12 * SR)) / SR
    j = np.zeros_like(t, dtype=np.float32)
    for f in (4800, 6200, 7400, 9100):
        j += np.sin(2 * np.pi * f * t + rng.random() * 6) * _exp(t, 40)
    noise = rng.standard_normal(len(t)).astype(np.float32) * _exp(t, 50) * 0.3
    return (j * 0.12 + noise).astype(np.float32)


def make_click(accent: bool) -> np.ndarray:
    t = np.arange(int(0.028 * SR)) / SR
    f = 1650 if accent else 1080
    amp = 0.55 if accent else 0.30
    return (np.sin(2 * np.pi * f * t) * np.exp(-t * 90) * amp).astype(np.float32)


def _fill_leading_clicks(audio: np.ndarray, bpm: float, until_s: float) -> np.ndarray:
    """Put quarter-note clicks in the silent count-off before a bounce stem starts."""
    if until_s <= 0.02:
        return audio
    out = audio.copy()
    if out.ndim == 1:
        out = np.stack([out, out], axis=1)
    beat = 60.0 / bpm
    n_beats = int(round(until_s / beat))
    acc = make_click(True)
    clk = make_click(False)
    for i in range(n_beats):
        src = acc if i % 4 == 0 else clk
        wave = np.stack([src, src], axis=1)
        at = int(round(i * beat * SR))
        b = min(len(out), at + len(wave))
        if b > at:
            out[at:b] += wave[: b - at]
    return np.clip(out, -1.0, 1.0).astype(np.float32)


def make_riser(seconds: float) -> np.ndarray:
    rng = np.random.default_rng(23)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n).astype(np.float32)
    # rising band: mix in differentiated noise as time increases
    hp = np.diff(noise, prepend=noise[:1])
    env = (t / max(seconds, 1e-6)) ** 2
    return ((noise * 0.25 + hp * env) * env * 0.35).astype(np.float32)


KIT = None


def kit() -> dict[str, np.ndarray]:
    global KIT
    if KIT is None:
        KIT = {
            "kick": make_kick(),
            "snare": make_snare(),
            "hat": make_hat(False),
            "ohat": make_hat(True),
            "crash": make_crash(),
            "tom": make_tom(120),
            "tamb": make_tamb(),
            "click": make_click(False),
            "click_acc": make_click(True),
        }
    return KIT


def mix_hits(hits: list[Hit], n: int, pan: float = 0.0, gain: float = 1.0) -> np.ndarray:
    out = np.zeros((n, 2), np.float32)
    k = kit()
    gl, gr = equal_power(pan)
    pan_hat = equal_power(min(1.0, pan + 0.25))
    for h in hits:
        samp = k.get(h.kind)
        if samp is None:
            continue
        i0 = int(h.start * SR)
        if i0 >= n:
            continue
        i1 = min(i0 + len(samp), n)
        sl = samp[: i1 - i0] * (gain * h.vel)
        pl, pr = pan_hat if h.kind in ("hat", "ohat", "tamb") else (gl, gr)
        out[i0:i1, 0] += sl * pl
        out[i0:i1, 1] += sl * pr
    return out


# ---------------------------------------------------------------------------
# MusicXML
# ---------------------------------------------------------------------------
def energy_for(name: str) -> int:
    n = name.lower()
    if "ending" in n:
        return 0
    if "verse" in n:
        return 1
    if "intro riff" in n or n == "intro" or "turn" in n or "outro" in n:
        return 2
    if "interlude" in n or "chorus" in n:
        return 3
    if "bridge" in n or "tag" in n:
        return 4
    return 2


def is_riff_section(name: str) -> bool:
    n = name.lower()
    return any(k in n for k in ("intro", "turn", "outro", "interlude"))


def load_meta(xml: Path) -> dict:
    meta = {"title": xml.stem, "key": "C", "bpm": 120.0, "writer": ""}
    for cand in (xml.parent / "masters" / "song.json", xml.parent / "song.json", HERE / "masters" / "song.json"):
        if cand.exists():
            j = json.loads(cand.read_text(encoding="utf-8"))
            meta["title"] = j.get("title") or meta["title"]
            meta["key"] = j.get("key") or meta["key"]
            meta["bpm"] = float(j.get("bpm") or meta["bpm"])
            meta["writer"] = j.get("writer") or ""
            break
    return meta


def parse_score(xml: Path) -> Score:
    from music21 import chord as m21chord
    from music21 import converter, expressions, harmony, meter, note, tempo

    print("parse", xml)
    s = converter.parse(str(xml))
    meta = load_meta(xml)
    title = meta["title"]
    if s.metadata and s.metadata.title:
        title = s.metadata.title
    mm = list(s.recurse().getElementsByClass(tempo.MetronomeMark))
    bpm = float(mm[0].number) if mm and mm[0].number else meta["bpm"]
    ts = list(s.recurse().getElementsByClass(meter.TimeSignature))
    bpb = int(ts[0].numerator) if ts else 4
    key_name = meta["key"]

    # sections
    rehs = []
    for r in s.recurse().getElementsByClass(expressions.RehearsalMark):
        rehs.append((float(r.getOffsetInHierarchy(s)), str(r.content or "Section")))
    rehs.sort()
    highest = float(s.highestTime)
    n_bars = int(round(highest / bpb))
    sections: list[Section] = []
    chorus_i = 0
    for i, (off, name) in enumerate(rehs):
        end = rehs[i + 1][0] if i + 1 < len(rehs) else highest
        loc = name
        if name.lower() == "chorus":
            chorus_i += 1
            loc = f"Chorus {chorus_i}"
        sections.append(Section(name, loc, off, end, energy_for(name)))

    # chords
    raw = []
    for c in s.recurse().getElementsByClass(harmony.ChordSymbol):
        off = float(c.getOffsetInHierarchy(s))
        fig = c.figure or "C"
        root = int(c.root().midi) if c.root() is not None else 60
        bass = int(c.bass().midi) if c.bass() is not None else root
        pitches = [int(p.midi) for p in c.pitches] or [root, root + 4, root + 7]
        raw.append((off, fig, root, bass, pitches))
    raw.sort()
    collapsed = []
    for off, fig, root, bass, pitches in raw:
        if collapsed and abs(collapsed[-1][0] - off) < 1e-6:
            collapsed[-1] = (off, fig, root, bass, pitches)
        else:
            collapsed.append((off, fig, root, bass, pitches))
    chords: list[ChordSpan] = []
    for i, (off, fig, root, bass, pitches) in enumerate(collapsed):
        end = collapsed[i + 1][0] if i + 1 < len(collapsed) else highest
        chords.append(ChordSpan(off, max(end - off, 0.25), fig, root, bass, pitches))

    def walk_notes(part):
        out = []
        for el in part.flatten().notes:
            if isinstance(el, harmony.ChordSymbol):
                continue
            off = float(el.offset)
            ql = float(el.quarterLength or 0.25)
            vel = int(el.volume.velocity or 80) if el.volume is not None else 80
            if isinstance(el, m21chord.Chord):
                mids = [int(p.midi) for p in el.pitches]
            else:
                mids = [int(el.pitch.midi)]
            lyric = False
            if getattr(el, "lyrics", None):
                lyric = any(getattr(ly, "text", None) for ly in el.lyrics)
            for m in mids:
                out.append((off, ql, m, vel, lyric))
        return out

    def classify(name: str) -> str:
        n = (name or "").lower()
        if any(x in n for x in ("drum", "kit", "perc")):
            return "drums"
        if "bass" in n:
            return "bass"
        if any(x in n for x in ("guitar", "gtr", "eg")):
            return "guitar"
        if any(x in n for x in ("vocal", "voice", "melody", "guide")):
            return "vocal"
        if any(x in n for x in ("piano", "key", "pad", "other")):
            return "piano"
        return "other"

    DRUM_KIND = {35: "kick", 36: "kick", 38: "snare", 40: "snare", 42: "hat", 44: "hat", 46: "ohat", 49: "crash", 57: "crash", 41: "tom", 43: "tom", 45: "tom", 47: "tom", 54: "tamb"}
    parts = list(s.parts)
    melody, piano, guitar, bass_notes, drum_hits = [], [], [], [], []
    if not sections:
        sections = [Section("Song", "Song", 0.0, highest, 2)]
    for i, p in enumerate(parts):
        kind = classify(p.partName or "")
        if kind == "other" and i == 0:
            kind = "vocal"
        notes = walk_notes(p)
        if kind == "vocal":
            melody.extend(notes)
        elif kind == "guitar":
            guitar.extend((off, ql, m, vel) for off, ql, m, vel, _ in notes)
        elif kind == "bass":
            bass_notes.extend((off, ql, m, vel) for off, ql, m, vel, _ in notes)
        elif kind == "drums":
            beat = 60.0 / bpm
            for off, ql, m, vel, _ in notes:
                drum_hits.append((off, DRUM_KIND.get(m, "kick"), max(0.25, vel / 127.0)))
        else:
            piano.extend((off, ql, m, vel) for off, ql, m, vel, _ in notes)

    return Score(
        title=title,
        key=key_name,
        bpm=bpm,
        beats_per_bar=bpb,
        n_bars=n_bars,
        sections=sections,
        chords=chords,
        melody=melody,
        piano=piano,
        guitar=guitar,
        bass_notes=bass_notes,
        drum_hits=drum_hits,
    )


# ---------------------------------------------------------------------------
# Arrange
# ---------------------------------------------------------------------------
def clamp_midi(n: int, lo: int, hi: int) -> int:
    while n < lo:
        n += 12
    while n > hi:
        n -= 12
    return n


def diatonic_third(midi_pitch: int) -> int:
    for d in (3, 4):
        if (midi_pitch + d) % 12 in B_MAJOR_PC:
            return midi_pitch + d
    return midi_pitch + 4


def guitar_shape(fig: str) -> list[int]:
    if fig in GUITAR_VOICINGS:
        return GUITAR_VOICINGS[fig]
    # fallback: triad around guitar range
    return [clamp_midi(p, 40, 68) for p in (60, 64, 67)]


def pad_shape(fig: str, pitches: list[int]) -> list[int]:
    if fig in PAD_VOICINGS:
        return PAD_VOICINGS[fig]
    return [clamp_midi(p + 12, 48, 76) for p in pitches[:4]]


def arrange(score: Score) -> dict[str, list]:
    """Return per-stem Note lists and drum/fx Hit lists."""
    bpm = score.bpm
    beat = 60.0 / bpm
    eighth = beat / 2
    sixteenth = beat / 4
    out: dict[str, list] = {name: [] for name, *_ in STEMS}

    # --- click (including count-off) ---
    total_beats = int(round(score.total_beats))
    for i in range(total_beats):
        t = i * beat
        accent = (i % score.beats_per_bar) == 0
        # last count-off bar: extra obvious
        in_count = i < score.count_off_beats
        if in_count and i >= score.count_off_beats - score.beats_per_bar:
            accent = True
        out["Click Track"].append(Hit(t, "click_acc" if accent else "click", 1.0 if accent else 0.7))

    # --- melody-driven ---
    # Unlyricized notes on the lead staff are the guitar hook, not a choir.
    for ql, dur, midi, vel, lyric in score.melody:
        t = score.sec(ql)
        d = dur * beat
        sec = score.section_at(ql)
        if lyric:
            out["Guide"].append(Note(t, d, midi, min(100, vel)))
            if sec.energy >= 3:
                out["BGVS"].append(Note(t, d, midi, int(vel * 0.55)))
                out["BGVS"].append(Note(t, d, diatonic_third(midi), int(vel * 0.42), strum=0.02))
        elif not score.guitar:
            out["EG 1"].append(Note(t, max(d, eighth) * 1.15, midi, min(127, vel + 36)))

    for ql, dur, midi, vel in score.piano:
        out["Piano"].append(Note(score.sec(ql), dur * beat, midi, vel))

    if score.guitar:
        for ql, dur, midi, vel in score.guitar:
            t = score.sec(ql)
            d = dur * beat
            out["EG 1"].append(Note(t, max(d, eighth) * 1.08, midi, min(127, vel + 18)))
            if midi >= 52:
                out["EG 1"].append(Note(t, max(d, eighth) * 1.08, clamp_midi(midi - 12, 40, 72), min(100, vel)))

    if score.bass_notes:
        for ql, dur, midi, vel in score.bass_notes:
            t = score.sec(ql)
            d = dur * beat
            out["Bass"].append(Note(t, d * 1.15, clamp_midi(midi, 28, 55), vel))
            out["Synth Bass"].append(Note(t, d * 1.2, clamp_midi(midi - 12, 24, 40), int(vel * 0.7)))

    # --- chord-driven ---
    n_ch = len(score.chords)
    for i, ch in enumerate(score.chords):
        sec = score.section_at(ch.ql)
        t0 = score.sec(ch.ql)
        t1 = score.sec(ch.ql + ch.dur)
        next_sec = score.section_at(score.chords[i + 1].ql) if i + 1 < n_ch else sec
        e = sec.energy
        fig = ch.figure
        bass = clamp_midi(ch.bass, 36, 51)
        sub = clamp_midi(ch.bass - 12, 28, 40)
        gshape = guitar_shape(fig)
        pshape = pad_shape(fig, ch.pitches)
        power = [clamp_midi(ch.root, 40, 52), clamp_midi(ch.root + 7, 47, 59), clamp_midi(ch.root + 12, 52, 64)]

        # bass (only if the score has no transcribed bass part)
        if not score.bass_notes:
            steps = 2 if e <= 1 else (4 if e == 2 else 8)
            step = ch.dur / steps
            for k in range(steps):
                if e == 0 and k > 0:
                    continue
                tt = score.sec(ch.ql + k * step)
                note_dur = step * beat * (1.6 if e <= 1 else 1.15)
                pitch = bass
                if e >= 3 and k % 4 == 2:
                    pitch = clamp_midi(bass + 7, 36, 54)
                elif e >= 3 and k % 4 == 3:
                    pitch = clamp_midi(bass + 12, 40, 55)
                vel = 78 if e <= 1 else (92 if e < 4 else 100)
                out["Bass"].append(Note(tt, note_dur, pitch, vel))
                if e >= 3:
                    out["Synth Bass"].append(Note(tt, note_dur * 1.2, sub, int(vel * 0.7)))

        # acoustic strums (skip when the score already has a transcribed guitar part)
        if not score.guitar and (not is_riff_section(sec.name) or e >= 3) and e > 0:
            eighths = int(round(ch.dur * 2))
            for k in range(eighths):
                down = k % 2 == 0
                if e <= 1 and not down:
                    continue
                tt = score.sec(ch.ql + k * 0.5)
                vel = 72 if down else 52
                if e >= 3:
                    vel += 18
                order = gshape if down else list(reversed(gshape))
                for j, p in enumerate(order):
                    out["AG Group"].append(Note(tt, eighth * 1.4, p, vel - j * 2, strum=j * 0.008))
                if not is_riff_section(sec.name):
                    top = order[-3:] if len(order) >= 3 else order
                    for j, p in enumerate(top):
                        out["EG 1"].append(Note(tt, eighth * 1.2, clamp_midi(p + 12, 52, 76), int(vel * 0.8) - j * 2, strum=j * 0.006))

        # muted EG chugs on chorus+ (rhythm bed under a written lead guitar)
        if e >= 3:
            eighths = int(round(ch.dur * 2))
            root_g = clamp_midi(ch.root, 40, 52)
            for k in range(eighths):
                tt = score.sec(ch.ql + k * 0.5)
                out["EG 2"].append(Note(tt, eighth * 0.45, root_g, 70, strum=0.0))
                out["EG 2"].append(Note(tt, eighth * 0.45, root_g + 7, 62, strum=0.004))

        # distortion power chords on bridge/tags and last choruses
        if e >= 3 and ("bridge" in sec.name.lower() or "tag" in sec.name.lower() or e == 3):
            for p in power:
                out["EG 2"].append(Note(t0, (t1 - t0) * 0.95, p, 64 if e == 3 else 78))

        # pads / EP / strings / choir
        if e >= 2:
            for p in pshape[:3]:
                vel = 36 if e == 2 else (52 if e == 3 else 64)
                out["Keys 1"].append(Note(t0, (t1 - t0) + 0.15, p, vel))
        if e >= 1 and not is_riff_section(sec.name):
            arps = pshape[:3] + [pshape[0] + 12]
            eighths = int(round(ch.dur * 2))
            for k in range(eighths):
                tt = score.sec(ch.ql + k * 0.5)
                out["Keys 2"].append(Note(tt, eighth * 1.3, arps[k % len(arps)], 54 if e < 3 else 66))
        if e >= 3:
            for p in pshape:
                out["Strings"].append(Note(t0, (t1 - t0) + 0.2, clamp_midi(p, 55, 79), 70))
        if e >= 4:
            for p in pshape[:3]:
                out["Choir 1"].append(Note(t0, (t1 - t0) + 0.1, clamp_midi(p, 57, 76), 72))

        # tambourine
        if e >= 3:
            eighths = int(round(ch.dur * 2))
            for k in range(eighths):
                tt = score.sec(ch.ql + k * 0.5)
                out["Tambourine"].append(Hit(tt, "tamb", 0.55 if k % 2 else 0.8))

        # FX riser into higher energy
        if i + 1 < n_ch and next_sec.energy > e and next_sec.start_ql - ch.ql - ch.dur < 0.1:
            if ch.dur >= 1.0:
                riser_beats = min(2.0, ch.dur)
                out["FX"].append(("riser", score.sec(ch.ql + ch.dur - riser_beats), riser_beats * beat, 0.8))

    # --- drums ---
    if score.drum_hits:
        for ql, kind, vel in score.drum_hits:
            out["Drums"].append(Hit(score.sec(ql), kind, float(vel)))
        last_count = (score.count_off_beats - 2) * beat
        out["Drums"].append(Hit(last_count, "click_acc", 0.4))
        out["Drums"].append(Hit(last_count + beat, "click_acc", 0.5))
        return out

    for bar in range(score.n_bars):
        ql = bar * score.beats_per_bar
        sec = score.section_at(ql)
        e = sec.energy
        tbar = score.sec(ql)
        next_ql = (bar + 1) * score.beats_per_bar
        next_sec = score.section_at(min(next_ql, score.sections[-1].end_ql - 0.01))
        fill = next_sec.energy > e or (next_sec.locator != sec.locator and e >= 2)

        if e == 0:
            if bar == int(score.sections[-1].start_ql // score.beats_per_bar):
                out["Drums"].append(Hit(tbar, "crash", 0.55))
                out["Drums"].append(Hit(tbar, "kick", 0.7))
            continue

        # kick / snare
        if e == 1:
            kicks = [0, 2]
            snares = [1, 3]
        elif e == 2:
            kicks = [0, 2]
            snares = [1, 3]
        elif e == 3:
            kicks = [0, 0.5, 2, 2.5]
            snares = [1, 3]
        else:
            kicks = [0, 0.5, 1.5, 2, 2.5, 3.5]
            snares = [1, 3]

        if fill:
            snares = [1, 2, 2.5, 3, 3.5]
            kicks = [0, 2]

        for kbeat in kicks:
            out["Drums"].append(Hit(tbar + kbeat * beat, "kick", 0.85 if kbeat in (0, 2) else 0.7))
        for sbeat in snares:
            out["Drums"].append(Hit(tbar + sbeat * beat, "snare", 0.9 if sbeat in (1, 3) else 0.65))

        hat_kind = "ohat" if e >= 4 else "hat"
        hat_div = 2 if e <= 2 else (4 if e >= 4 else 2)
        steps = score.beats_per_bar * hat_div
        for k in range(steps):
            vel = 0.38 if k % hat_div else 0.55
            if e <= 2:
                vel *= 0.55
            out["Drums"].append(Hit(tbar + k * (beat / hat_div), hat_kind if (e >= 4 and k == steps - 1) else "hat", vel))

        # crash on section downbeat
        if abs(ql - sec.start_ql) < 1e-6 and e >= 3:
            out["Drums"].append(Hit(tbar, "crash", 0.7 if e < 4 else 0.9))
        if fill:
            out["Drums"].append(Hit(tbar + 3.5 * beat, "tom", 0.75))

    # count-off: a couple of sticks on last two beats
    last_count = (score.count_off_beats - 2) * beat
    out["Drums"].append(Hit(last_count, "click_acc", 0.4))
    out["Drums"].append(Hit(last_count + beat, "click_acc", 0.5))
    out["Drums"].append(Hit(score.sec(0.0), "crash", 0.6))

    return out


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------
def collect_needed(events: list[Note]) -> set[int]:
    return {int(n.midi) for n in events if isinstance(n, Note)}


def render_stem(name: str, events: list, n: int, pan: float, fonts: dict) -> np.ndarray:
    if name == "Click Track":
        audio = mix_hits(events, n, pan=0.0, gain=1.0)
        return peak_normalize(audio, 0.70)
    if name == "Drums":
        audio = mix_hits(events, n, pan=0.0, gain=1.05)
        return peak_normalize(cheap_reverb(audio, mix=0.08, delay_ms=28), 0.78)
    if name == "Tambourine":
        audio = mix_hits(events, n, pan=pan, gain=0.9)
        return peak_normalize(cheap_reverb(audio, mix=0.12), 0.62)
    if name == "FX":
        out = np.zeros((n, 2), np.float32)
        for ev in events:
            if not isinstance(ev, tuple) or ev[0] != "riser":
                continue
            _, start, dur, vel = ev
            samp = make_riser(dur)
            i0 = int(start * SR)
            i1 = min(i0 + len(samp), n)
            sl = samp[: i1 - i0] * vel
            out[i0:i1, 0] += sl
            out[i0:i1, 1] += sl
        return peak_normalize(cheap_reverb(out, mix=0.25, delay_ms=70, decay=0.4), 0.70)

    sf_name = SF_FOR[name]
    notes = [e for e in events if isinstance(e, Note)]
    samples = fonts[sf_name]
    gain = {
        "Guide": 0.34,
        "Bass": 0.42,
        "Synth Bass": 0.30,
        "AG Group": 0.22,
        "EG 1": 0.42,
        "EG 2": 0.22,
        "Piano": 0.30,
        "Keys 1": 0.20,
        "Keys 2": 0.18,
        "Strings": 0.22,
        "BGVS": 0.24,
        "Choir 1": 0.26,
    }.get(name, 0.25)
    release = 0.8 if name in ("Keys 1", "Strings", "Choir 1", "Synth Bass") else 0.32
    audio = mix_notes(notes, samples, n, pan=pan, gain=gain, release=release)
    mix = 0.22 if name in ("Strings", "Choir 1", "BGVS", "Keys 1", "Guide") else 0.12
    target = 0.68 if name in ("Bass", "Synth Bass", "Piano", "Guide") else 0.62
    return peak_normalize(cheap_reverb(audio, mix=mix), target)


# ---------------------------------------------------------------------------
# Ableton Live set
# ---------------------------------------------------------------------------
def shift_ids(elem: ET.Element, delta: int):
    for e in elem.iter():
        if "Id" in e.attrib:
            try:
                e.set("Id", str(int(e.get("Id")) + delta))
            except ValueError:
                pass


def set_val(elem: ET.Element | None, value: str):
    if elem is not None:
        elem.set("Value", value)


def build_als(
    template: Path,
    dest: Path,
    stems: list[tuple[str, int]],
    bpm: float,
    total_beats: float,
    clip_end: float,
    n_samples: int,
    locators: list[tuple[float, str]],
    ext: str = "m4a",
):
    tree = ET.parse(str(template))
    root = tree.getroot()
    tracks_el = root.find("LiveSet/Tracks")
    template_track = tracks_el.find("AudioTrack")
    # drop existing audio tracks, keep returns
    for t in list(tracks_el.findall("AudioTrack")):
        tracks_el.remove(t)
    for i, (name, color) in enumerate(stems):
        t = copy.deepcopy(template_track)
        t.set("Id", str(10 + i))
        shift_ids(t, (i + 1) * 2000)
        set_val(t.find("./Name/EffectiveName"), name)
        set_val(t.find("./Name/UserName"), name)
        set_val(t.find("./ColorIndex"), str(color))
        clip = t.find(".//AudioClip")
        set_val(clip.find("Name"), name)
        for tag in ("CurrentEnd",):
            set_val(clip.find(tag), f"{clip_end:.8f}")
        loop = clip.find("Loop")
        for tag in ("LoopEnd", "OutMarker", "HiddenLoopEnd"):
            set_val(loop.find(tag), f"{clip_end:.8f}")
        ref = clip.find(".//FileRef")
        set_val(ref.find("Name"), f"{name}.{ext}")
        # 1 = RelativeToDocument: Stems/ sits next to the .als, so this resolves with
        # no dependence on Live recognising the folder as a Project. (3 is
        # RelativeToProject and needs the Ableton Project Info folder to be honoured.)
        set_val(ref.find("RelativePathType"), "1")
        for el in ref.findall("RelativePath/RelativePathElement"):
            el.set("Dir", STEMS_DIR)
        set_val(clip.find(".//DefaultDuration"), str(n_samples))
        set_val(clip.find(".//DefaultSampleRate"), str(SR))
        set_val(clip.find(".//LastModDate"), str(int(time.time())))
        tracks_el.insert(i, t)

    # tempo
    tempo = root.find("LiveSet/MasterTrack//Tempo/ArrangerAutomation/Events")
    if tempo is not None:
        for child in list(tempo):
            tempo.remove(child)
        ev = ET.SubElement(tempo, "FloatEvent")
        ev.set("Time", "-63072000")
        ev.set("Value", str(bpm))

    trans = root.find("LiveSet/Transport")
    set_val(trans.find("LoopStart"), "0")
    set_val(trans.find("LoopLength"), str(total_beats))
    set_val(trans.find("CurrentTime"), str(total_beats))
    set_val(trans.find("LoopOn"), "true")

    loc_parent = root.find("LiveSet/Locators/Locators")
    if loc_parent is None:
        loc_parent = root.find("LiveSet/Locators")
    for child in list(loc_parent):
        if child.tag == "Locator":
            loc_parent.remove(child)
    for beat, name in locators:
        loc = ET.SubElement(loc_parent, "Locator")
        ET.SubElement(loc, "LomId").set("Value", "0")
        ET.SubElement(loc, "Time").set("Value", str(beat))
        ET.SubElement(loc, "Name").set("Value", name)
        ET.SubElement(loc, "Annotation").set("Value", "")
        ET.SubElement(loc, "IsSongStart").set("Value", "false")

    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(dest, "wb") as f:
        f.write(xml_bytes)


def pack_name(title: str, key: str, bpm: float) -> str:
    safe = re.sub(r'[<>:"/\\|?*]', "", title).strip()
    return f"{safe}-{safe}-{key}-{bpm:.2f}bpm"


def write_album(dest: Path, title: str, subtitle: str):
    from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

    if ALBUM_SRC.exists():
        im = Image.open(ALBUM_SRC).convert("RGB")
        im = im.resize((436, 436), Image.Resampling.LANCZOS)
        im = ImageEnhance.Contrast(im).enhance(1.08)
        im.save(dest, "JPEG", quality=90, optimize=True)
        return
    im = Image.new("RGB", (436, 436), (12, 16, 28))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 300, 436, 436], fill=(18, 22, 36))
    try:
        font = ImageFont.truetype("arial.ttf", 28)
        small = ImageFont.truetype("arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
        small = font
    d.text((24, 340), title.upper(), fill=(236, 214, 160), font=font)
    d.text((24, 380), subtitle, fill=(180, 180, 190), font=small)
    im.save(dest, "JPEG", quality=88)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def _load_arr() -> dict:
    if ARRANGEMENT.exists():
        return json.loads(ARRANGEMENT.read_text(encoding="utf-8"))
    return {}


def _load_prod() -> dict:
    if PRODUCTION.exists():
        return json.loads(PRODUCTION.read_text(encoding="utf-8"))
    return {}


def _prod_tracks(prod: dict) -> dict[str, dict]:
    out = {}
    for t in prod.get("tracks") or []:
        if t.get("name"):
            out[t["name"]] = t
    return out


CUE_STEMS = {
    "click track",
    "click",
    "count off",
    "count-off",
    "cue",
    "cues",
    "queues",
}


def is_cue_stem(name: str, spec: dict | None = None) -> bool:
    if spec and spec.get("cue") is True:
        return True
    if spec and spec.get("inFullMix") is False:
        return True
    n = (name or "").strip().lower()
    if n in CUE_STEMS:
        return True
    if n.startswith("click"):
        return True
    return False


def _midi_audio(name: str, events: dict, n: int, fonts: dict) -> np.ndarray:
    pan = 0.0
    for sname, _color, span, _g in STEMS:
        if sname == name:
            pan = span
            break
    key = "Drums" if name.startswith("Drums") else name
    return render_stem(key, events.get(key, events.get(name, [])), n, pan, fonts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xml", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=HERE / "multitracks_out")
    ap.add_argument("--no-zip", action="store_true")
    ap.add_argument("--midi-only", action="store_true", help="render only from MusicXML (no mix extraction)")
    ap.add_argument("--from-mix", action="store_true", help="force mix-separation path")
    ap.add_argument("--from-stems", action="store_true", help="use stems_out/ m4as (MelBand/SW + bounce) instead of Demucs")
    ap.add_argument("--real-only", action="store_true", help="publish only tracks fed by real stems; never fall back to MIDI")
    ap.add_argument("--format", choices=sorted(FORMATS), default="m4a",
                    help="pack audio format. ogg/flac/wav are native to Live; m4a needs an external codec")
    args = ap.parse_args()

    xml = args.xml
    if xml is None:
        for cand in (HERE / "masters" / "score.musicxml", HERE / "RedemptionHasCome.musicxml", HERE / "masters" / "from_source.musicxml"):
            if cand.exists():
                xml = cand
                break
    if xml is None or not xml.exists():
        sys.exit("no .musicxml found")

    if not ALS_TEMPLATE.exists():
        sys.exit(f"missing ALS template {ALS_TEMPLATE}")

    arr = _load_arr()
    prod = _load_prod()
    prod_map = _prod_tracks(prod)
    midi_only = args.midi_only or (str(arr.get("render") or "").lower() == "midi")
    if args.from_mix or args.from_stems:
        midi_only = False
    score = parse_score(xml)
    print(f"  {score.title}  {score.key}  {score.bpm} BPM  {score.n_bars} bars  render={'midi' if midi_only else 'mix'}", flush=True)
    print(f"  sections: {', '.join(s.locator for s in score.sections)}", flush=True)
    print("arrange", flush=True)
    events = arrange(score)
    n = int(score.total_seconds * SR)
    clip_end = n / SR
    pack_music_start = score.count_off_beats * 60.0 / score.bpm
    beat = 60.0 / score.bpm

    sf_for = dict(SF_FOR)
    for name, spec in prod_map.items():
        if spec.get("sound") and name in events and spec["sound"] not in ("click", "kit"):
            sf_for[name] = spec["sound"]
    needed: dict[str, set[int]] = {}
    # real-only never renders a note, so it never needs a soundfont
    for stem, sf in ({} if args.real_only else sf_for).items():
        if stem in events:
            needed.setdefault(sf, set()).update(collect_needed(events[stem]))
    fonts: dict[str, dict[int, np.ndarray]] = {}
    for sf, pitches in needed.items():
        print(f"  soundfont {sf} ({len(pitches)} notes)", flush=True)
        fonts[sf] = load_font(sf, pitches)

    midi_cache: dict[str, np.ndarray] = {}

    def midi_of(name: str) -> np.ndarray:
        if name not in midi_cache:
            print(f"  midi render {name}", flush=True)
            midi_cache[name] = _midi_audio(name, events, n, fonts)
        return midi_cache[name]

    from mt_mix import (
        apply_fx,
        align_mix_to_score,
        choose_mix_source,
        extract_mix_wav,
        first_music_time,
        load_stems_out,
        peak_normalize as mix_peak,
        place_on_pack,
        read_audio,
        select_real_stems,
        separate_demucs,
        split_lead_bgv,
    )

    guitar_name = "EG 1"
    TRACK_TO_STEM = {
        "Click Track": "bounce",
        "Guide": "vocals",
        "Drums": "drums",
        "Drums (Live)": "drums",
        "Bass": "bass",
        "EG 1": "guitar",
        "Acoustic Guitar": "guitar",
        "AG Group": "guitar",
        "Piano": "piano",
        "Keys 1": "other",
        "BGVS": "vocals:bgv",
    }
    if args.real_only:
        # BGVS is a split of the vocal stem, not its own recording — leave it out.
        TRACK_TO_STEM.pop("BGVS")

    mix_stems: dict[str, np.ndarray] = {}
    mix_audio = None
    mix_offset = None
    mix_music_start = None
    mix_path = None
    if not midi_only:
        mix_path, mix_info = choose_mix_source(HERE, arr, CACHE)
    if mix_path:
        print(f"mix {mix_path}", flush=True)
        try:
            mix_wav = extract_mix_wav(mix_path, CACHE / f"mix_{mix_path.stem}.wav")
            mix_audio = read_audio(mix_wav)
            mix_music_start = first_music_time(mix_audio, SR)
            raw_sep: dict[str, np.ndarray] = {}
            stems_dir = HERE / "stems_out"
            if args.from_stems or (stems_dir.exists() and any(stems_dir.glob("*.m4a"))):
                print("  loading stems_out", flush=True)
                raw_sep = load_stems_out(stems_dir, CACHE / "pack_stems")
            if not raw_sep:
                model = (arr.get("mix") or {}).get("separator") or "htdemucs_6s"
                sep_paths = separate_demucs(mix_wav, CACHE / "separated", model)
                print(f"  separated {sorted(sep_paths)}", flush=True)
                raw_sep = {key: read_audio(p) for key, p in sep_paths.items()}
            if args.real_only and raw_sep:
                raw_sep = select_real_stems(raw_sep, mix_audio)
            head = float(np.sqrt(np.mean(mix_audio[: int(0.35 * SR)] ** 2)))
            body = float(np.sqrt(np.mean(mix_audio[int(8 * SR) : int(24 * SR)] ** 2)))
            if mix_music_start > 0.25:
                mix_offset = mix_music_start
                print(f"  leading silence; music at {mix_offset:.3f}s", flush=True)
            elif head > 0.12 * body:
                mix_offset = 0.0
                print(f"  mix starts cold (head/body={head / (body + 1e-9):.2f}); bar1 at 0.00s", flush=True)
            elif args.real_only:
                # No score to align against and nothing synthesized to align with:
                # the stems are already the mix's own timeline.
                mix_offset = 0.0
                print("  real-only; bar 1 at 0.00s", flush=True)
            else:
                i0 = int(pack_music_start * SR)
                i1 = int((pack_music_start + 12.8) * SR)
                riff = midi_of("EG 1")[i0:i1]
                align_src = raw_sep.get("guitar", mix_audio)
                mix_offset = align_mix_to_score(align_src, riff, SR, search_seconds=16.0, max_offset=2.5)
                print(f"  score bar 1 at mix {mix_offset:.3f}s; pack music at {pack_music_start:.3f}s", flush=True)
            for key, audio in raw_sep.items():
                if key == "bounce":
                    # bounce is mix-aligned from t=0 (count-in in the leading bar)
                    click_at = max(0.0, pack_music_start - (mix_offset or 0.0))
                    placed = place_on_pack(audio, n, SR, 0.0, click_at)
                    mix_stems[key] = _fill_leading_clicks(placed, score.bpm, click_at)
                else:
                    mix_stems[key] = place_on_pack(audio, n, SR, mix_offset, pack_music_start)
            if "vocals" in mix_stems:
                melody = [(score.sec(ql), dur * beat, midi) for ql, dur, midi, _v, _ly in score.melody]
                lead, bgv = split_lead_bgv(mix_stems["vocals"], melody, SR)
                mix_stems["vocals:lead"] = lead
                mix_stems["vocals:bgv"] = bgv
            guitar_name = "EG 1" if "drums" in mix_stems else "Acoustic Guitar"
        except Exception as e:
            print(f"  mix path failed ({type(e).__name__}: {e}); MIDI fallback", flush=True)
            mix_stems = {}
            mix_offset = None
            mix_audio = None
            mix_music_start = None

    folder = pack_name(score.title, score.key, score.bpm)
    pack_dir = args.out / folder
    mt_dir = pack_dir / STEMS_DIR
    if pack_dir.exists():
        shutil.rmtree(pack_dir)
    mt_dir.mkdir(parents=True)
    if ABLETON_INFO.exists():
        shutil.copytree(ABLETON_INFO, pack_dir / "Ableton Project Info", dirs_exist_ok=True)
    write_album(pack_dir / "Album.jpg", score.title, f"{score.key} · {score.bpm:.0f} BPM")

    song_mix = np.zeros((n, 2), np.float32)
    inst_mix = np.zeros((n, 2), np.float32)  # song_mix without the vocal stems
    wav_dir = CACHE / "wav_stems"
    wav_dir.mkdir(parents=True, exist_ok=True)

    if mix_stems and arr.get("stems"):
        job_stems = []
        for spec in arr["stems"]:
            job_stems.append((spec["name"], int(spec.get("color", 0)), spec))
    elif args.real_only and mix_stems:
        # One Live track per stem that survived select_real_stems. A vocal +
        # guitar mix must not grow a phantom bass/keys/piano section.
        real_tracks = {
            "bounce": ("Click Track", 199, 0.18),
            "vocals": ("Guide", 199, 0.55),
            "drums": ("Drums", 152, 0.85),
            "bass": ("Bass", 142, 0.80),
            "guitar": (guitar_name, 159, 0.50),
            "piano": ("Piano", 156, 0.62),
            "other": ("Keys 1", 156, 0.40),
        }
        job_stems = []
        for key in ("bounce", "vocals", "drums", "bass", "guitar", "piano", "other"):
            if key not in mix_stems or key not in real_tracks:
                continue
            name, color, gain = real_tracks[key]
            job_stems.append((name, color, {
                "name": name,
                "source": f"mix:{key}",
                "peak": 0.74 if key == "guitar" else 0.70,
                "mixGain": gain,
                "cue": name == "Click Track",
                "inFullMix": name != "Click Track",
            }))
    else:
        job_stems = []
        for name, color, _pan, gain in STEMS:
            pt = prod_map.get(name) or {}
            mix_key = TRACK_TO_STEM.get(name)
            source = f"mix:{mix_key}" if mix_key and mix_stems and mix_key in mix_stems else "midi"
            job_stems.append((name, int(pt.get("color", color)), {
                "name": name,
                "source": source,
                "peak": 0.74 if name == "EG 1" else 0.70,
                "mixGain": pt.get("mixGain", MIDI_MIX_GAIN.get(name, gain)),
                "midiSource": f"midi:{name}",
                "fx": pt.get("effects") or MIDI_STEM_FX.get(name, []),
                "cue": bool(pt.get("cue", name == "Click Track")),
                "inFullMix": pt.get("inFullMix", name not in ("Click Track", "Synth Bass")),
            }))

    if args.real_only:
        job_stems = [j for j in job_stems if str(j[2].get("source") or "").startswith("mix:")]
        if not job_stems:
            sys.exit("real-only: no stems came from the recording")

    als_tracks = []
    for name, color, spec in job_stems:
        source = spec.get("source") or "midi"
        audio = None
        origin = "midi"
        if source.startswith("mix:") and mix_stems:
            key = source.split(":", 1)[1]
            if key in mix_stems:
                audio = mix_stems[key]
                origin = f"mix:{key}"
            elif key == "vocals:lead" and "vocals" in mix_stems:
                audio = mix_stems["vocals"]
                origin = "mix:vocals"
            if audio is not None and float(np.max(np.abs(audio))) < 0.02:
                print(f"  {name}: mix:{key} too quiet, MIDI fallback", flush=True)
                audio = None
        if audio is None and args.real_only:
            print(f"  {name}: no real audio, dropped", flush=True)
            continue
        if audio is None:
            midi_key = spec.get("midiSource") or source
            render_name = MIDI_RENDER_AS.get(midi_key, name if name in events else "Piano")
            if render_name not in events and name in events:
                render_name = name
            audio = midi_of(render_name)
            origin = f"midi:{render_name}"
        if origin.startswith("midi:"):
            audio = apply_fx(audio, spec.get("fx"), bpm=score.bpm, sr=SR)
        if origin.startswith("mix:"):
            peak = float(np.max(np.abs(audio)) or 0)
            if peak > 0.98:
                audio = audio * (0.98 / peak)
        else:
            peak = float(np.max(np.abs(audio)) or 0)
            if peak > 0.92:
                audio = audio * (0.92 / peak)
        wav = wav_dir / f"{name}.wav"
        m4a = mt_dir / f"{name}.{args.format}"
        write_wav(wav, audio)
        encode_m4a(wav, m4a, args.format)
        gain = float(spec.get("mixGain", 0.6))
        if not is_cue_stem(name, spec):
            song_mix += audio * gain
            if not str(spec.get("source") or "").startswith("mix:vocals"):
                inst_mix += audio * gain
        als_tracks.append((name, color))
        print(f"  {name:16} {origin:22} {m4a.stat().st_size:9}  peak={float(np.max(np.abs(audio))):.3f}", flush=True)

    locators = [(0.0, "Count Off")]
    for s in score.sections:
        locators.append((score.count_off_beats + s.start_ql, s.locator))
    locators.append((score.total_beats, "Count Off"))

    print("ableton set", flush=True)
    build_als(
        ALS_TEMPLATE,
        pack_dir / SESSION,
        als_tracks,
        score.bpm,
        score.total_beats,
        clip_end,
        n,
        locators,
        args.format,
    )

    # Listening mix: no click/cues. Use the chosen source mix from first audible
    # audio so a pre-chart guitar solo/pickup is not trimmed away.
    song_n = int(round(score.n_bars * score.beats_per_bar * 60.0 / score.bpm * SR))
    song_start = int(round(pack_music_start * SR))
    full = None
    if mix_audio is not None:
        t0 = mix_music_start if mix_music_start is not None else first_music_time(mix_audio, SR)
        i0 = max(0, int(round(max(0.0, t0 - 0.05) * SR)))
        i1 = min(len(mix_audio), i0 + song_n)
        sl = mix_audio[i0:i1]
        if sl.ndim == 1:
            sl = np.stack([sl, sl], axis=1)
        if len(sl) < song_n:
            sl = np.pad(sl, ((0, song_n - len(sl)), (0, 0)))
        full = sl[:song_n].astype(np.float32)
        origin = "original mix"
    if full is None:
        chunk = song_mix[song_start : song_start + song_n]
        if len(chunk) < song_n:
            chunk = np.pad(chunk, ((0, song_n - len(chunk)), (0, 0)))
        full = chunk[:song_n]
        origin = "summed stems"
    fade = min(int(0.01 * SR), max(1, len(full) // 20))
    if fade:
        full = full.copy()
        full[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)[:, None]
        full[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)[:, None]
    full = limit(full, 0.95)
    write_wav(wav_dir / "_fullmix.wav", full)
    pack_full = pack_dir / "Full Mix.m4a"
    side_full = args.out / f"{folder}-fullmix.m4a"
    encode_m4a(wav_dir / "_fullmix.wav", pack_full)
    try:
        shutil.copy2(pack_full, side_full)
    except OSError:
        try:
            encode_m4a(wav_dir / "_fullmix.wav", side_full)
        except Exception as e:
            print(f"  sidecar full mix skipped ({e})", flush=True)
    print(f"full mix ({origin}) {pack_full}  {len(full) / SR:.2f}s", flush=True)

    # Site preview: 30 s of the listening mix from the first chorus (else the top), 1 s fades.
    # ponytail: no loudness analysis — first chorus is the hook often enough.
    first_chorus = next((sec for sec in score.sections if "chorus" in sec.locator.lower()), None)
    p0 = int(round((first_chorus.start_ql * 60.0 / score.bpm if first_chorus else 0.0) * SR))
    p0 = max(0, min(p0, max(0, len(full) - PREVIEW_SECONDS * SR)))
    clip = full[p0 : p0 + PREVIEW_SECONDS * SR].copy()
    pf = min(SR, len(clip) // 4)
    clip[:pf] *= np.linspace(0, 1, pf, dtype=np.float32)[:, None]
    clip[-pf:] *= np.linspace(1, 0, pf, dtype=np.float32)[:, None]
    preview = args.out / "preview.m4a"  # short name: the core DB caps file paths at 100 chars
    write_wav(wav_dir / "_preview.wav", clip)
    encode_m4a(wav_dir / "_preview.wav", preview)
    print(f"preview {preview}  {len(clip) / SR:.1f}s from {p0 / SR:.1f}s", flush=True)

    # Karaoke bed: summed stems minus vocals, same slice as the stem-summed full mix.
    if any(str(spec.get("source") or "").startswith("mix:vocals") for _, _, spec in job_stems):
        chunk = inst_mix[song_start : song_start + song_n]
        if len(chunk) < song_n:
            chunk = np.pad(chunk, ((0, song_n - len(chunk)), (0, 0)))
        write_wav(wav_dir / "_instrumental.wav", limit(chunk[:song_n], 0.95))
        encode_m4a(wav_dir / "_instrumental.wav", args.out / "instrumental.m4a")
        print("instrumental", args.out / "instrumental.m4a", flush=True)

    if not args.no_zip:
        zip_path = args.out / f"{folder}.zip"
        print("zip", zip_path, flush=True)
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for p in pack_dir.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(args.out).as_posix())
        print("  zip bytes", zip_path.stat().st_size, flush=True)

    print("done", pack_dir, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
