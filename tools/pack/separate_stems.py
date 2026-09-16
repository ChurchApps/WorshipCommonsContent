"""Separate a mix into the instruments that are actually in it.

Pipeline:
  1. MelBand Roformer vocals
  2. BS-Roformer SW 6-stem on the mix (guitar/drums/bass/piano/other)
  3. Keep real instruments; fold separator leftovers back into the accompaniment

SW jointly models guitar vs drums, which stays crisper when the kit is in.
A vocal + acoustic-guitar mix becomes vocals + guitar, not a phantom band.
Writes AAC .m4a stems by default.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

from audio_separator.separator import Separator

VOCAL_MODEL = "vocals_mel_band_roformer.ckpt"
BAND_MODEL = "BS-Roformer-SW.ckpt"
MODEL_DIR = Path.home() / ".cache" / "audio-separator-models"
DEFAULT_BITRATE = "256k"


def _ffmpeg(args: list[str]) -> None:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg failed")


def _resolve(path: str | Path, folder: Path) -> Path:
    p = Path(path)
    if p.exists():
        return p
    candidate = folder / p.name
    if candidate.exists():
        return candidate
    raise FileNotFoundError(path)


def _stem_path(paths: list[str], folder: Path, *labels: str) -> Path:
    keys = [label.lower() for label in labels]
    for raw in paths:
        p = _resolve(raw, folder)
        name = p.stem.lower()
        if any(key in name for key in keys):
            return p
    raise FileNotFoundError(f"no stem matching {labels} in {paths}")


def _make_separator(output_dir: Path, mdxc_segment: int = 256) -> Separator:
    return Separator(
        output_dir=str(output_dir),
        output_format="WAV",
        model_file_dir=str(MODEL_DIR),
        sample_rate=44100,
        normalization_threshold=0.9,
        use_soundfile=True,
        use_autocast=True,
        mdxc_params={
            "segment_size": mdxc_segment,
            "override_model_segment_size": False,
            "batch_size": 1,
            "overlap": 8,
            "pitch_shift": 0,
        },
        demucs_params={
            "segment_size": "Default",
            "shifts": 2,
            "overlap": 0.25,
            "segments_enabled": True,
        },
    )


def _separate_with_retry(
    separator: Separator,
    source: Path,
    names: dict[str, str],
    model: str,
    mdxc: bool,
) -> list[str]:
    try:
        return separator.separate(str(source), names)
    except RuntimeError as exc:
        if not mdxc or "out of memory" not in str(exc).lower():
            raise
        print(f"CUDA OOM on {model}, retrying with smaller segments")
        import torch

        torch.cuda.empty_cache()
        tighter = _make_separator(Path(separator.output_dir), mdxc_segment=160)
        tighter.load_model(model_filename=model)
        return tighter.separate(str(source), names)


def separate(
    input_path: Path,
    output_dir: Path,
    bitrate: str = DEFAULT_BITRATE,
    keep_wav: bool = False,
) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    work = output_dir / ".work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()

    mix = work / "mix.wav"
    print(f"decode {input_path.name} -> 24-bit wav")
    _ffmpeg(["-i", str(input_path), "-acodec", "pcm_s24le", "-ar", "44100", str(mix)])
    # audio-separator deletes its input after a pass; keep a second copy for the band model.
    mix_band = work / "mix-band.wav"
    shutil.copy2(mix, mix_band)

    print(f"vocals: {VOCAL_MODEL}")
    vocal_sep = _make_separator(work)
    vocal_sep.load_model(model_filename=VOCAL_MODEL)
    vocal_files = _separate_with_retry(
        vocal_sep,
        mix,
        {"Vocals": "vocals", "Other": "instrumental", "Instrumental": "instrumental"},
        VOCAL_MODEL,
        mdxc=True,
    )
    vocals_wav = _stem_path(vocal_files, work, "vocals")
    print(f"  vocals wav: {vocals_wav.name}")

    print(f"band: {BAND_MODEL} (guitar/drums/bass/piano/other)")
    band_sep = _make_separator(work)
    band_sep.load_model(model_filename=BAND_MODEL)
    band_files = _separate_with_retry(
        band_sep,
        mix_band,
        {
            "Guitar": "guitar",
            "Drums": "drums",
            "Bass": "bass",
            "Piano": "piano",
            "Other": "other",
            "Vocals": "sw_vocals",
        },
        BAND_MODEL,
        mdxc=True,
    )
    stem_map = {
        "vocals": vocals_wav,
        "guitar": _stem_path(band_files, work, "guitar"),
        "drums": _stem_path(band_files, work, "drums"),
        "bass": _stem_path(band_files, work, "bass"),
        "piano": _stem_path(band_files, work, "piano"),
        "other": _stem_path(band_files, work, "other"),
    }
    try:
        import soundfile as sf
        from mt_mix import read_audio, select_real_stems

        arrays = {name: read_audio(path) for name, path in stem_map.items()}
        kept = select_real_stems(arrays, read_audio(mix_band if mix_band.exists() else mix))
        for name, audio in kept.items():
            dest = stem_map.get(name) or (work / f"{name}.wav")
            sf.write(str(dest), audio, 44100)
            stem_map[name] = dest
        for name in [k for k in list(stem_map) if k not in kept]:
            del stem_map[name]
    except Exception as exc:
        print(f"  stem prune skipped ({type(exc).__name__}: {exc}); packing all stems")
    written: list[str] = []
    prefix = input_path.stem
    for stale in output_dir.glob(f"{prefix}_*.m4a"):
        key = stale.stem[len(prefix) + 1 :]
        if key not in stem_map and key != "bounce":
            stale.unlink(missing_ok=True)
    for name, wav in stem_map.items():
        dest = output_dir / f"{prefix}_{name}.m4a"
        print(f"encode {name} -> {dest.name} ({bitrate} AAC)")
        _ffmpeg(
            [
                "-i",
                str(wav),
                "-c:a",
                "aac",
                "-b:a",
                bitrate,
                "-movflags",
                "+faststart",
                str(dest),
            ]
        )
        written.append(str(dest))

    if not keep_wav:
        shutil.rmtree(work, ignore_errors=True)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract cleaner m4a stems")
    parser.add_argument("input", type=Path, help="Audio file (mp3, m4a, wav, flac, ...)")
    parser.add_argument("-o", "--output-dir", type=Path, default=Path("stems_out"))
    parser.add_argument("-b", "--bitrate", default=DEFAULT_BITRATE, help="AAC bitrate, e.g. 192k or 256k")
    parser.add_argument("--keep-wav", action="store_true", help="Keep intermediate WAV files")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"missing input: {args.input}", file=sys.stderr)
        return 1

    print(f"input:  {args.input.resolve()}")
    print(f"output: {args.output_dir.resolve()}")
    files = separate(args.input, args.output_dir, bitrate=args.bitrate, keep_wav=args.keep_wav)
    print("wrote:")
    for path in files:
        p = Path(path)
        size = p.stat().st_size if p.exists() else 0
        print(f"  {p}  ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
