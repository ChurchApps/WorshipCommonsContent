"""Generate a click + callout bounce stem (no mix audio).

Matches the shape of a Life.Church rehearsal bounce:
  - stick click on every beat for the full mix length
  - two-bar cues before each section: "one two three four" / "{Section} two three four"
  - opening bar(s) before the first downbeat: "Intro two three four"

  python make_bounce.py TheWay_01_RedemptionHasCome_LyricVideo.m4a
"""

from __future__ import annotations

import argparse
import os
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from mt_mix import SR, first_music_time

HERE = Path(os.environ.get("MT_ROOT") or Path(__file__).resolve().parent)
TTS_CACHE = HERE / "_mt_cache" / "tts_words"
COUNT_WORDS = ("one", "two", "three", "four")


def _ffmpeg(args: list[str]) -> None:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg failed")


def _decode(src: Path, dest: Path) -> np.ndarray:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg(["-i", str(src), "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SR), str(dest)])
    y, sr = sf.read(str(dest), dtype="float32", always_2d=True)
    if sr != SR:
        raise RuntimeError(f"unexpected sr {sr}")
    return y


def read_bpm(explicit: float | None) -> float:
    if explicit:
        return float(explicit)
    song = HERE / "masters" / "song.json"
    if song.exists():
        data = json.loads(song.read_text(encoding="utf-8"))
        if data.get("bpm"):
            return float(data["bpm"])
    return 0.0


def estimate_bpm(y: np.ndarray) -> float:
    import librosa

    onset = librosa.onset.onset_strength(y=y.mean(axis=1), sr=SR)
    tempo, _ = librosa.beat.beat_track(onset_envelope=onset, sr=SR, start_bpm=120)
    return float(round(float(np.atleast_1d(tempo)[0])))


def _sapi_speak(text: str, dest: Path, rate: int = -2) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    wav = str(dest.resolve())
    safe = text.replace("'", "")
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "try { $s.SelectVoice('Microsoft David Desktop') } catch {}; "
        f"$s.Rate = {int(rate)}; "
        f"$s.SetOutputToWaveFile('{wav}'); "
        f"$s.Speak('{safe}'); "
        "$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)


def _trim_voice(y: np.ndarray, rel: float = 0.03) -> np.ndarray:
    e = np.abs(y)
    thr = rel * float(np.max(e) + 1e-9)
    idx = np.where(e > thr)[0]
    if len(idx) == 0:
        return y
    pad = int(0.008 * SR)
    return y[max(0, idx[0] - pad) : min(len(y), idx[-1] + pad)]


def _fit_word(y: np.ndarray, target: float) -> np.ndarray:
    import librosa

    y = _trim_voice(y)
    dur = len(y) / SR
    if dur > target * 1.05:
        y = librosa.effects.time_stretch(y, rate=dur / target)
    peak = float(np.max(np.abs(y)) + 1e-9)
    return (y * (0.62 / peak)).astype(np.float32)


def tts_word(word: str, beat: float, long_word: bool) -> np.ndarray:
    key = re.sub(r"[^a-z0-9]+", "", word.lower()) or "word"
    raw = TTS_CACHE / f"{key}_r-2.wav"
    TTS_CACHE.mkdir(parents=True, exist_ok=True)
    if not raw.exists() or raw.stat().st_size < 1000:
        print(f"  tts {word}")
        _sapi_speak(word, raw)
    y, sr = sf.read(str(raw), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != SR:
        import librosa

        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    span = (1.15 if long_word else 0.88) * beat
    return _fit_word(y.astype(np.float32), span)


def make_stick(accent: bool = False) -> np.ndarray:
    n = int(0.045 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(7 if accent else 11)
    noise = rng.standard_normal(n).astype(np.float32)
    crack = np.diff(noise, prepend=noise[:1]) * np.exp(-t * 220)
    body = np.sin(2 * np.pi * 1900 * t) * np.exp(-t * 100)
    high = np.sin(2 * np.pi * 4200 * t) * np.exp(-t * 160)
    amp = 0.40 if accent else 0.32
    hit = (crack * 0.55 + body * 0.35 + high * 0.22) * amp
    return np.clip(hit, -1, 1).astype(np.float32)


def _place(buf: np.ndarray, src: np.ndarray, at: int) -> None:
    if src.ndim == 1:
        src = np.stack([src, src], axis=1)
    a = max(0, at)
    b = min(len(buf), at + len(src))
    sa = a - at
    sb = sa + (b - a)
    if b <= a:
        return
    buf[a:b] += src[sa:sb]


def speak_label(name: str) -> str:
    n = re.sub(r"\s+\d+$", "", name.strip(), flags=re.I)
    n = n.replace("-", " ")
    low = n.lower()
    aliases = {
        "intro riff": "Intro",
        "intro": "Intro",
        "verse": "Verse",
        "chorus": "Chorus",
        "turnaround": "Turnaround",
        "interlude": "Interlude",
        "bridge": "Bridge",
        "tags": "Tags",
        "tag": "Tags",
        "outro": "Outro",
        "ending": "Ending",
        "drums": "Drums",
        "breakdown": "Breakdown",
        "build": "Build",
        "vamp": "Vamp",
        "instrumental": "Instrumental",
    }
    if low in aliases:
        return aliases[low]
    return n.split()[0] if n else "Section"


def load_sections(bpm: float, first_music: float) -> list[tuple[str, float]]:
    """Section name + start time in the mix. Prefers MusicXML rehearsal marks."""
    bar = 4 * 60.0 / bpm
    xml_candidates = [
        HERE / "RedemptionHasCome.musicxml",
        HERE / "masters" / "score.musicxml",
        HERE / "masters" / "from_source.musicxml",
    ]
    xml_candidates += sorted(HERE.glob("*.musicxml"))
    seen: set[Path] = set()
    for xml in xml_candidates:
        xml = xml.resolve()
        if xml in seen or not xml.exists():
            continue
        seen.add(xml)
        text = xml.read_text(encoding="utf-8")
        meas = None
        out: list[tuple[str, float]] = []
        for line in text.splitlines():
            m = re.search(r'<measure[^>]*number="([0-9]+)"', line)
            if m:
                meas = int(m.group(1))
            r = re.search(r"<rehearsal[^>]*>([^<]+)</rehearsal>", line)
            if r and meas is not None:
                t = first_music + (meas - 1) * bar
                out.append((r.group(1).strip(), t))
        if out:
            return out
    src = HERE / "masters" / "from_source.json"
    if src.exists():
        data = json.loads(src.read_text(encoding="utf-8"))
        beat = 60.0 / bpm
        return [(name, first_music + float(ql) * beat) for name, ql in data.get("sections") or []]
    return [("Intro", first_music)]


def render_bounce(n: int, bpm: float, first_music: float, sections: list[tuple[str, float]]) -> np.ndarray:
    beat = 60.0 / bpm
    bar = 4 * beat
    buf = np.zeros((n, 2), np.float32)
    stick = make_stick(False)
    stick_acc = make_stick(True)
    n_beats = int(np.ceil(n / (beat * SR)))
    for i in range(n_beats):
        at = int(round(i * beat * SR))
        _place(buf, stick_acc if i % 4 == 0 else stick, at)

    # beat-index -> spoken word (later cues overwrite)
    spoken: dict[int, str] = {}

    def put_count(t0: float) -> None:
        b0 = int(round(t0 / beat))
        for k, w in enumerate(COUNT_WORDS):
            spoken[b0 + k] = w

    def put_named(t0: float, label: str) -> None:
        b0 = int(round(t0 / beat))
        spoken[b0] = speak_label(label)
        spoken[b0 + 1] = "two"
        spoken[b0 + 2] = "three"
        spoken[b0 + 3] = "four"

    # opening count-off in the leading silence
    lead_bars = int(round(first_music / bar)) if first_music > 0.25 else 0
    open_name = sections[0][0] if sections else "Intro"
    if lead_bars >= 2:
        put_count(first_music - 2 * bar)
        put_named(first_music - bar, open_name)
    elif lead_bars >= 1:
        put_named(first_music - bar, open_name)

    for name, t in sections:
        if abs(t - first_music) < bar * 0.5:
            continue  # covered by opening
        if t - 2 * bar >= -0.02:
            put_count(t - 2 * bar)
        if t - bar >= -0.02:
            put_named(t - bar, name)

    cache: dict[str, np.ndarray] = {}
    max_beat = n_beats
    for b, word in sorted(spoken.items()):
        if b < 0 or b >= max_beat:
            continue
        long_word = word.lower() not in COUNT_WORDS
        if word not in cache:
            cache[word] = tts_word(word, beat, long_word)
        _place(buf, cache[word], int(round(b * beat * SR)))

    peak = float(np.max(np.abs(buf)) + 1e-9)
    if peak > 0.89:
        buf *= 0.89 / peak
    return buf


def make_bounce(
    src: Path,
    dest: Path,
    bpm: float | None = None,
    bitrate: str = "256k",
) -> Path:
    work = HERE / "_mt_cache"
    work.mkdir(exist_ok=True)
    mix = _decode(src, work / f"bounce_src_{src.stem}.wav")
    bpm_v = read_bpm(bpm)
    if bpm_v <= 0:
        bpm_v = estimate_bpm(mix)
        print(f"estimated bpm {bpm_v}")
    else:
        print(f"bpm {bpm_v}")
    beat = 60.0 / bpm_v
    music = first_music_time(mix, SR)
    snapped = round(music / beat) * beat
    if abs(snapped - music) < 0.04 and snapped > 0:
        music = snapped
    sections = load_sections(bpm_v, music)
    print(f"mix {len(mix)/SR:.3f}s  downbeat {music:.3f}s  sections {len(sections)}")
    for name, t in sections:
        print(f"  {t:7.2f}s  {name}")
    out = render_bounce(len(mix), bpm_v, music, sections)
    wav = work / f"bounce_out_{dest.stem}.wav"
    sf.write(str(wav), out, SR, subtype="PCM_24")
    dest.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg(
        ["-i", str(wav), "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", str(dest)]
    )
    wav.unlink(missing_ok=True)
    return dest


def main() -> int:
    p = argparse.ArgumentParser(description="Generate a click + callout bounce stem")
    p.add_argument("input", type=Path, help="Mix to match for length, tempo, and downbeat")
    p.add_argument("-o", "--output", type=Path, help="Output m4a path")
    p.add_argument("--bpm", type=float, help="Tempo. Default: masters/song.json or estimate")
    p.add_argument("-b", "--bitrate", default="256k")
    args = p.parse_args()
    if not args.input.exists():
        print(f"missing input: {args.input}", file=sys.stderr)
        return 1
    dest = args.output or HERE / "stems_out" / f"{args.input.stem}_bounce.m4a"
    path = make_bounce(args.input, dest, bpm=args.bpm, bitrate=args.bitrate)
    print(f"wrote {path}  ({path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
