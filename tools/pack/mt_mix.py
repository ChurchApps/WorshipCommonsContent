"""Mix-informed multitrack helpers: separate, align, FX, vocal split.

Generic/repeatable. Any song with a bounce/lyric-video + MusicXML can use this.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, istft, sosfilt, stft

SR = 44100


def load_arrangement(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


_SKIP_MIX_NAME = re.compile(
    r"(click|count.?off|preview|full.?mix|pad-|album|desktop|stage-|chart-)",
    re.I,
)
_MIX_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".wav", ".m4a", ".mp3", ".aiff", ".aif", ".flac"}


def find_mix(root: Path, arr: dict) -> Path | None:
    """Back-compat: first listed file that exists. Prefer choose_mix_source()."""
    cands = discover_mix_candidates(root, arr)
    return cands[0] if cands else None


def discover_mix_candidates(root: Path, arr: dict) -> list[Path]:
    mix = arr.get("mix") or {}
    ordered: list[Path] = []
    seen: set[Path] = set()

    def add(p: Path):
        try:
            p = p.resolve()
        except Exception:
            return
        if p in seen or not p.exists() or not p.is_file():
            return
        seen.add(p)
        ordered.append(p)

    for name in [mix.get("file"), *(mix.get("fallbacks") or [])]:
        if not name:
            continue
        p = Path(name)
        add(p if p.is_absolute() else root / name)
    for p in sorted(root.iterdir()):
        if p.suffix.lower() in _MIX_EXTS and not _SKIP_MIX_NAME.search(p.name):
            add(p)
    return ordered


def first_music_time(y: np.ndarray, sr: int = SR, abs_floor: float = 0.012) -> float:
    """Seconds of leading silence/near-silence before the mix actually starts."""
    mono = y.mean(axis=1) if y.ndim > 1 else y
    hop = max(1, int(0.02 * sr))
    n = max(1, (len(mono) - hop) // hop)
    env = np.empty(n, np.float32)
    for i in range(n):
        sl = mono[i * hop : (i + 1) * hop]
        env[i] = np.sqrt(np.mean(sl * sl) + 1e-12)
    p95 = float(np.percentile(env, 95))
    thr = max(abs_floor, 0.08 * p95)
    hits = np.where(env > thr)[0]
    if len(hits) == 0:
        return 0.0
    return float(hits[0] * hop / sr)


def _band_power(mono: np.ndarray, sr: int, lo: float, hi: float) -> float:
    if len(mono) < 64:
        return 0.0
    w = np.hanning(len(mono)).astype(np.float32)
    spec = np.abs(np.fft.rfft(mono * w))
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    m = (freqs >= lo) & (freqs < hi)
    if not np.any(m):
        return 0.0
    return float(np.mean(spec[m] ** 2))


def score_mix_audio(y: np.ndarray, sr: int = SR) -> dict:
    """How much this sounds like a finished song mix vs a partial bounce/stem."""
    t0 = first_music_time(y, sr)
    i0 = int(t0 * sr)
    i1 = min(len(y), i0 + int(12.0 * sr))
    sl = y[i0:i1]
    if sl.ndim > 1:
        mono = sl.mean(axis=1)
    else:
        mono = sl
    rms = float(np.sqrt(np.mean(sl ** 2) + 1e-12))
    e_low = _band_power(mono, sr, 40.0, 250.0)
    e_pres = _band_power(mono, sr, 800.0, 6000.0)  # lead guitar / vocal presence
    # Need both low end and presence so a thin minus-lead bounce loses to the release mix.
    richness = float(((e_low + 1e-18) * (e_pres + 1e-18)) ** 0.5) * (rms + 1e-6)
    return {
        "first_music": t0,
        "rms": rms,
        "e_low": e_low,
        "e_pres": e_pres,
        "score": richness,
    }


def score_mix_file(path: Path, cache_dir: Path, sr: int = SR) -> dict:
    """Score from the first 45s so ranking is cheap before a full extract."""
    probe = cache_dir / f"probe_{path.stem}.wav"
    cache_dir.mkdir(parents=True, exist_ok=True)
    if not probe.exists() or probe.stat().st_mtime < path.stat().st_mtime:
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(path), "-t", "45", "-ac", "2", "-ar", str(sr), str(probe)],
            check=True,
        )
    y, file_sr = sf.read(str(probe), dtype="float32", always_2d=True)
    if file_sr != sr:
        import librosa
        y = librosa.resample(y.T, orig_sr=file_sr, target_sr=sr).T.astype(np.float32)
    info = score_mix_audio(y, sr)
    info["path"] = path
    return info


def choose_mix_source(root: Path, arr: dict, cache_dir: Path) -> tuple[Path, dict] | tuple[None, None]:
    """Pick the richest finished mix among listed files and song-folder media.

    Lyric videos / masters beat 'bounce stem' / minus-lead bounces because they
    keep lead guitar and vocal presence. Ranking is by audio, not filename.
    """
    cands = discover_mix_candidates(root, arr)
    if not cands:
        return None, None
    ranked = []
    for p in cands:
        try:
            info = score_mix_file(p, cache_dir)
        except Exception as e:
            print(f"  skip mix candidate {p.name}: {type(e).__name__} {e}", flush=True)
            continue
        ranked.append(info)
    if not ranked:
        return None, None
    ranked.sort(key=lambda x: x["score"], reverse=True)
    print("  mix candidates (richest first):", flush=True)
    for info in ranked:
        print(
            f"    {info['score']:.4g}  pres={info['e_pres']:.3g}  low={info['e_low']:.3g}  "
            f"rms={info['rms']:.3f}  music@{info['first_music']:.2f}s  {info['path'].name}",
            flush=True,
        )
    best = ranked[0]
    return best["path"], best


def extract_mix_wav(src: Path, dest: Path, sr: int = SR) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return dest
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(src), "-ac", "2", "-ar", str(sr), str(dest)],
        check=True,
    )
    return dest


def separate_demucs(mix_wav: Path, out_dir: Path, model: str = "htdemucs_6s") -> dict[str, Path]:
    """Run Demucs. Returns map of stem name -> wav path. Cached if complete."""
    dest = out_dir / model / mix_wav.stem
    expected_6 = ["drums", "bass", "other", "vocals", "guitar", "piano"]
    expected_4 = ["drums", "bass", "other", "vocals"]
    if dest.exists():
        have = {p.stem: p for p in dest.glob("*.wav")}
        if all(k in have for k in expected_6) or all(k in have for k in expected_4):
            print(f"  demucs cache hit {dest}")
            return have
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, "-m", "demucs",
        "-n", model,
        "-o", str(out_dir),
        "--segment", "7",
        "--overlap", "0.25",
    ]
    try:
        import torch
        cmd.extend(["-d", "cuda" if torch.cuda.is_available() else "cpu"])
    except Exception:
        cmd.extend(["-d", "cpu"])
    cmd.append(str(mix_wav))
    print("  demucs", " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0 and model != "htdemucs":
        print("  6-stem failed, falling back to htdemucs 4-stem")
        return separate_demucs(mix_wav, out_dir, "htdemucs")
    if r.returncode != 0:
        raise RuntimeError("demucs failed")
    have = {p.stem: p for p in dest.glob("*.wav")}
    if not have:
        # default demucs layout: out/model/track/stem.wav
        alt = out_dir / model / mix_wav.stem
        have = {p.stem: p for p in alt.glob("*.wav")}
    return have


def _rms_env(y: np.ndarray, hop: int = 512) -> np.ndarray:
    if y.ndim > 1:
        y = y.mean(axis=1)
    n = len(y)
    if n < hop:
        return np.array([np.sqrt(np.mean(y**2))], np.float32)
    frames = (n - hop) // hop + 1
    out = np.empty(frames, np.float32)
    for i in range(frames):
        sl = y[i * hop : i * hop + hop]
        out[i] = np.sqrt(np.mean(sl * sl) + 1e-12)
    return out


def align_mix_to_score(
    mix: np.ndarray,
    template: np.ndarray,
    sr: int,
    search_seconds: float = 16.0,
    max_offset: float = 3.0,
) -> float:
    """Return mix time (seconds) that corresponds to template[0] (score bar 1).

    max_offset caps how late bar 1 can sit in the mix (pre-roll / video pad).
    The intro riff repeats, so an uncapped search locks onto later statements.
    """
    hop = 256
    mix_e = _rms_env(mix[: int(search_seconds * sr)], hop)
    tpl_e = _rms_env(template, hop)
    mix_e = mix_e / (np.max(mix_e) + 1e-9)
    tpl_e = tpl_e / (np.max(tpl_e) + 1e-9)
    if len(mix_e) <= len(tpl_e) + 2:
        return 0.0
    corr = np.correlate(mix_e, tpl_e, mode="valid")
    cap = max(1, int(max_offset * sr / hop))
    corr = corr[: min(len(corr), cap)]
    lag = int(np.argmax(corr))
    return lag * hop / sr


def refine_to_click(drums: np.ndarray, click: np.ndarray, sr: int, pack_music_start: float, search: float = 0.45) -> float:
    """Seconds to add to mix_offset so drum transients lock to the click grid."""
    hop = 256
    i0 = int(pack_music_start * sr)
    i1 = int((pack_music_start + 16.0) * sr)
    d = _rms_env(drums[i0:i1].mean(axis=1), hop)
    c = _rms_env(click[i0:i1].mean(axis=1), hop)
    d = np.maximum(0.0, d - np.median(d))
    c = np.maximum(0.0, c - np.median(c))
    corr = np.correlate(d, c, mode="full")
    lags = np.arange(-len(c) + 1, len(d))
    max_lag = int(search * sr / hop)
    mask = np.abs(lags) <= max_lag
    if not np.any(mask):
        return 0.0
    lag = int(lags[mask][np.argmax(corr[mask])])
    return lag * hop / sr


def place_on_pack(
    src: np.ndarray,
    n_pack: int,
    sr: int,
    mix_offset: float,
    pack_music_start: float,
) -> np.ndarray:
    """src is mix-timeline audio. pack t=pack_music_start reads src t=mix_offset."""
    if src.ndim == 1:
        src = np.stack([src, src], axis=1)
    ch = src.shape[1]
    out = np.zeros((n_pack, ch), np.float32)
    shift = int(round((mix_offset - pack_music_start) * sr))
    # out[i] = src[i + shift]
    src_i0 = max(0, shift)
    src_i1 = min(len(src), n_pack + shift)
    dst_i0 = src_i0 - shift
    dst_i1 = dst_i0 + (src_i1 - src_i0)
    if src_i1 > src_i0 and dst_i1 > dst_i0:
        out[dst_i0:dst_i1] = src[src_i0:src_i1, :ch]
    return out


def apply_fx(audio: np.ndarray, fx_list: list[dict] | None, bpm: float = 120.0, sr: int = SR) -> np.ndarray:
    if not fx_list:
        return audio
    x = audio.astype(np.float32)
    for fx in fx_list:
        kind = (fx.get("type") or "").lower()
        if kind in ("drive", "overdrive", "distortion"):
            amt = float(fx.get("amount", 0.3))
            g = 1.0 + 4.0 * amt
            x = np.tanh(x * g) / np.tanh(g)
        elif kind == "amp":
            sos = butter(2, 90, btype="highpass", fs=sr, output="sos")
            x = sosfilt(sos, x, axis=0).astype(np.float32)
            x = np.tanh(x * 1.8) / np.tanh(1.8)
        elif kind == "presence":
            hz = float(fx.get("hz", 2800))
            amt = float(fx.get("amount", 0.45))
            lo, hi = max(400.0, hz / 1.7), min(sr * 0.45, hz * 1.7)
            sos = butter(2, [lo, hi], btype="bandpass", fs=sr, output="sos")
            x = (x + amt * sosfilt(sos, x, axis=0)).astype(np.float32)
        elif kind in ("lowpass", "highpass"):
            hz = float(fx.get("hz", 120 if kind == "lowpass" else 80))
            btype = "lowpass" if kind == "lowpass" else "highpass"
            sos = butter(2, hz, btype=btype, fs=sr, output="sos")
            x = sosfilt(sos, x, axis=0).astype(np.float32)
        elif kind == "delay":
            timing = (fx.get("timing") or "").lower()
            beats = fx.get("beats")
            if beats is None:
                beats = {"dotted-eighth": 0.75, "eighth": 0.5, "quarter": 1.0, "sixteenth": 0.25}.get(timing, 0.5)
            beats = float(beats)
            mixv = float(fx.get("mix", 0.2))
            fb = float(fx.get("feedback", 0.25))
            d = max(1, int(beats * 60.0 / max(bpm, 1) * sr))
            y = x.copy()
            for k in range(1, 5):
                off = d * k
                if off >= len(x):
                    break
                y[off:] += (mixv * (fb ** (k - 1))) * x[:-off]
            x = y
        elif kind == "reverb":
            mix = float(fx.get("mix", 0.18))
            delay_ms = fx.get("delayMs")
            if delay_ms is None and fx.get("decaySeconds"):
                delay_ms = float(fx["decaySeconds"]) * 18.0
            delay_ms = float(delay_ms if delay_ms is not None else 42)
            d = int(delay_ms * sr / 1000)
            y = x.copy()
            if 0 < d < len(x):
                y[d:] += 0.28 * x[:-d]
                y[d:, 0] += 0.14 * x[:-d, 1]
                y[d:, 1] += 0.14 * x[:-d, 0]
            x = (1 - mix) * x + mix * y
    return x.astype(np.float32)


def split_lead_bgv(
    vocals: np.ndarray,
    melody: list[tuple[float, float, int]],
    sr: int = SR,
) -> tuple[np.ndarray, np.ndarray]:
    """MIDI-informed split of a vocal stem into lead vs everything else.

    melody: (start_sec, dur_sec, midi) in the SAME timeline as vocals.
    """
    if vocals.ndim == 1:
        vocals = np.stack([vocals, vocals], axis=1)
    n_fft = 4096
    hop = 1024
    lead_ch = []
    bgv_ch = []
    # build mask from mono
    f, ts, Z = stft(vocals.mean(axis=1), fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
    mask = np.zeros(Z.shape, np.float32)
    dt = hop / sr
    for start, dur, midi in melody:
        f0 = 440.0 * (2.0 ** ((midi - 69) / 12.0))
        i0 = max(0, int(start / dt))
        i1 = min(mask.shape[1], max(i0 + 1, int((start + dur) / dt) + 1))
        for h in range(1, 7):
            freq = f0 * h
            if freq >= sr / 2:
                break
            bw = max(28.0, freq * 0.025)
            band = np.exp(-0.5 * ((f - freq) / bw) ** 2).astype(np.float32)
            mask[:, i0:i1] += band[:, None]
    mx = float(np.max(mask)) or 1.0
    mask = np.clip(mask / mx, 0, 1)
    lead_m = 0.12 + 0.88 * mask
    bgv_m = np.clip(1.0 - 0.8 * mask, 0.04, 1.0)
    for c in range(vocals.shape[1]):
        _, _, Zc = stft(vocals[:, c], fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
        _, lead = istft(Zc * lead_m, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
        _, bgv = istft(Zc * bgv_m, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
        lead_ch.append(lead)
        bgv_ch.append(bgv)
    n = len(vocals)
    lead = np.stack([_fit(a, n) for a in lead_ch], axis=1)
    bgv = np.stack([_fit(a, n) for a in bgv_ch], axis=1)
    return lead.astype(np.float32), bgv.astype(np.float32)


def _fit(a: np.ndarray, n: int) -> np.ndarray:
    if len(a) >= n:
        return a[:n]
    return np.pad(a, (0, n - len(a)))


def read_audio(path: Path, sr: int = SR) -> np.ndarray:
    data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    if file_sr != sr:
        import librosa
        data = librosa.resample(data.T, orig_sr=file_sr, target_sr=sr).T.astype(np.float32)
    return data


_STEM_KEYS = ("vocals", "drums", "bass", "guitar", "piano", "other", "bounce")


def load_stems_out(folder: Path, cache_dir: Path, sr: int = SR) -> dict[str, np.ndarray]:
    """Load separate_stems.py / make_bounce.py m4as from stems_out/."""
    out: dict[str, np.ndarray] = {}
    if not folder.exists():
        return out
    cache_dir.mkdir(parents=True, exist_ok=True)
    for p in sorted(folder.glob("*.m4a")):
        stem = p.stem.lower()
        key = next((k for k in _STEM_KEYS if stem.endswith("_" + k) or stem == k), None)
        if not key:
            continue
        wav = cache_dir / f"pack_{p.stem}.wav"
        extract_mix_wav(p, wav, sr)
        out[key] = read_audio(wav, sr)
        print(f"  stems_out {key}: {p.name}  {len(out[key])/sr:.2f}s", flush=True)
    return out


def peak_normalize(x: np.ndarray, target: float = 0.72, floor: float = 1e-4) -> np.ndarray:
    m = float(np.max(np.abs(x))) if x.size else 0.0
    if m < floor:
        return x.astype(np.float32)
    return (x * (target / m)).astype(np.float32)
