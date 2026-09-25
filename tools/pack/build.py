#!/usr/bin/env python3
"""Build the stems pack for songs that have a granted master recording.

  python tools/pack/build.py                                    whole library
  python tools/pack/build.py songs/en                           every English song
  python tools/pack/build.py songs/en/<slug>-<id>               one package

No master recording, no pack. Nothing here turns MIDI into a bundle a church
downloads: every track in the zip came out of the recording someone granted us,
and only the instruments that are actually in that recording.
Idempotent — a package whose pack is newer than its inputs is skipped, so running
the whole library nightly costs nothing when nothing changed.

Per package (see .notes/song-pipeline.md §6):
  sources/master/<audio>  -> stems (MelBand + BS-Roformer SW)
                          -> click + section-callout bounce
                          -> output/audio/: pack zip, full mix, preview

Needs: ffmpeg on PATH, CUDA torch, audio-separator, music21, pillow. See README.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

# folder names carry every script; a cp1252 console must not kill the job
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
AUDIO_EXT = {".wav", ".flac", ".m4a", ".mp3", ".aiff", ".aif", ".ogg", ".opus", ".mp4", ".mov"}
# our own source changing is a reason to rebuild
TOOL_FILES = [HERE / n for n in ("build.py", "generate_multitracks.py", "mt_mix.py", "separate_stems.py", "make_bounce.py", "stems_to_score.py")]
# Scratch lives outside the package: extracted mix, separated stems, soundfonts, WAV caches.
# Only stems_out/ survives a build — it is the expensive part and the only thing worth a rerun.
WORK_ROOT = ROOT / "tools" / ".cache" / "pack"


def prune(work: Path) -> None:
    """Drop everything in the work dir except the separated stems."""
    for child in work.iterdir():
        if child.name == "stems_out":
            continue
        shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)


def read_json(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def mtime(p: Path) -> float:
    return p.stat().st_mtime if p.exists() else 0.0


def packages(target: Path):
    """Song packages under `target` (a package, a language dir, or the repo root)."""
    if (target / "song.json").exists():
        yield target
        return
    for p in sorted(target.rglob("song.json")):
        yield p.parent


class Skip(Exception):
    pass


def gate(pkg: Path) -> tuple[dict, Path, dict]:
    """Refuse to build unless the recording grant is real and on file."""
    song = read_json(pkg / "song.json")
    master_dir = pkg / "sources" / "master"
    masters = [p for p in sorted(master_dir.glob("*")) if p.is_file() and p.suffix.lower() in AUDIO_EXT] if master_dir.exists() else []
    if not masters:
        raise Skip("no master recording")
    if len(masters) > 1:
        raise Skip(f"{len(masters)} files in sources/master; one master per song")
    master = masters[0]

    if not song.get("rights", {}).get("recording"):
        raise Skip("song.json rights.recording is null; the master has no grant")
    rows = read_json(pkg / "sources" / "manifest.json").get("files", [])
    rel = f"master/{master.name}"
    row = next((r for r in rows if r.get("file") == rel), None)
    if not row:
        raise Skip(f"no manifest row for sources/{rel}")
    for field in ("license", "evidence", "submittedBy", "acquired"):
        if not row.get(field):
            raise Skip(f"manifest row for {rel} has no {field}")
    if not (pkg / "sources" / row["evidence"]).exists():
        raise Skip(f"grant evidence sources/{row['evidence']} is missing")
    # a translation with its own master inherits bpm/key from the parent (tools/lib.mjs INHERITED_FIELDS)
    pid = (song.get("parent") or {}).get("id")
    if pid:
        for p in ROOT.glob(f"songs/*/*-{pid}/song.json"):
            base = read_json(p)
            for k in ("bpm", "key", "timeSignature"):
                song.setdefault(k, base.get(k))
    # no bpm is not a refusal: the transcription below reads the tempo off the recording and stamps it
    return song, master, row


def stamp_chordpro(path: Path, song: dict) -> None:
    """Keep {key}/{tempo} in the ChordPro header equal to song.json (validate.mjs checks)."""
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    for name, val in (("key", song.get("key")), ("tempo", song.get("bpm"))):
        if val in (None, ""):
            continue
        line = "{%s: %s}" % (name, val)
        pat = re.compile(r"^\{%s:.*\}[ \t]*$" % name, re.M)
        if pat.search(text):
            text = pat.sub(lambda _m: line, text, count=1)
        else:
            m = re.search(r"^\{time:.*\}\r?\n", text, re.M)
            text = text[: m.end()] + line + ("\r\n" if "\r\n" in m.group(0) else "\n") + text[m.end():] if m else line + "\n" + text
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    manifest = path.parent / "manifest.json"
    if manifest.exists():  # validate.mjs checks the recorded hash
        m = json.loads(manifest.read_text(encoding="utf-8"))
        for row in m.get("files", []):
            if row.get("file") == path.name and row.get("sha256"):
                row["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        with open(manifest, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(m, indent=2, ensure_ascii=False) + "\n")


def _maybe_stamp_detected(pkg: Path, song: dict, info: dict) -> None:
    """Fill empty key / harvest-default bpm from the recording. Does not overwrite a real key."""
    changed = False
    bpm = info.get("bpm")
    if bpm and (not song.get("bpm") or song.get("bpm") == 80):
        song["bpm"] = int(round(float(bpm)))
        changed = True
    key = info.get("key")
    if key and not song.get("key"):
        song["key"] = key
        changed = True
    if changed:
        stamp_chordpro(pkg / "sources" / "lyrics.chordpro", song)
        with open(pkg / "song.json", "w", encoding="utf-8", newline='\n') as f:  # repo is LF; text mode writes CRLF
            f.write(json.dumps(song, indent=2, ensure_ascii=False) + '\n')


def duration_seconds(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def stub_score(dest: Path, song: dict, seconds: float) -> None:
    """A score-shaped placeholder: right tempo and length, no notes, no sections.

    Only used when the package has no score.musicxml. The pack generator
    needs a timeline; with this it gets one, and the click track gets no spoken
    section callouts because nothing knows where the sections are.
    """
    beats_per_bar, beat_unit = (int(x) for x in str(song.get("timeSignature") or "4/4").split("/"))
    bpm = float(song["bpm"])
    bars = max(1, round(seconds / (beats_per_bar * 60.0 / bpm)))
    divisions = 1
    measures = "\n".join(
        f'      <measure number="{i + 1}">\n'
        f'        <note><rest measure="yes"/><duration>{beats_per_bar}</duration></note>\n'
        f'      </measure>'
        for i in range(bars)
    )
    dest.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
        '<score-partwise version="3.1">\n'
        f'  <work><work-title>{song.get("title", "")}</work-title></work>\n'
        '  <part-list><score-part id="P1"><part-name>Guide</part-name></score-part></part-list>\n'
        '  <part id="P1">\n'
        '      <measure number="0" implicit="yes">\n'
        f'        <attributes><divisions>{divisions}</divisions>'
        f'<time><beats>{beats_per_bar}</beats><beat-type>{beat_unit}</beat-type></time>'
        '<clef><sign>G</sign><line>2</line></clef></attributes>\n'
        f'        <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
        f'<per-minute>{bpm:g}</per-minute></metronome></direction-type><sound tempo="{bpm:g}"/></direction>\n'
        f'        <note><rest measure="yes"/><duration>{beats_per_bar}</duration></note>\n'
        '      </measure>\n'
        f'{measures}\n'
        '  </part>\n'
        '</score-partwise>\n',
        encoding="utf-8",
    )


def link_or_copy(src: Path, dest: Path) -> None:
    if dest.exists() and mtime(dest) >= mtime(src):
        return
    if dest.exists():
        dest.unlink()
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


def build(pkg: Path, song: dict, master: Path, force: bool = False, fmt: str = "ogg") -> str:
    out = pkg / "output" / "audio"
    inputs = [master, pkg / "song.json", pkg / "sources" / "manifest.json", *TOOL_FILES]
    # source wins over output, same rule as tools/lib.mjs
    score_src = next((p for p in (pkg / "sources" / "score.musicxml",
                                  pkg / "output" / "composition" / "score.musicxml") if p.exists()), None)
    if score_src:
        inputs.append(score_src)
    zips = list(out.glob("*.zip"))
    if zips and not force and min(mtime(z) for z in zips) > max(mtime(p) for p in inputs):
        return "up to date"

    work = WORK_ROOT / pkg.name
    (work / "masters").mkdir(parents=True, exist_ok=True)
    shutil.copy2(pkg / "song.json", work / "masters" / "song.json")
    link_or_copy(master, work / master.name)
    (work / "masters" / "arrangement.json").write_text(
        json.dumps({"render": "mix", "mix": {"file": master.name, "countOffBars": 2}}, indent=2) + "\n",
        encoding="utf-8",
    )

    env = dict(os.environ, MT_ROOT=str(work), MT_ASSETS=str(HERE / "assets"),
               MT_SF_DIR=str(ROOT / "tools" / ".cache" / "sf"))
    cover = pkg / "sources" / "cover.webp"
    if cover.exists():
        env["MT_ALBUM"] = str(cover)

    stems_dir = work / "stems_out"
    fresh = stems_dir.exists() and min([mtime(p) for p in stems_dir.glob("*.m4a")] or [0]) > mtime(master)
    if not fresh:
        print(f"  separating {master.name}", flush=True)
        sys.path.insert(0, str(HERE))
        from separate_stems import separate
        separate(master, stems_dir, bitrate="256k")

    # A granted mix always yields a generated score unless a human score already
    # lives in sources/. Sketch MIDI/MusicXML/lead-sheet go in output/composition/.
    # a transcribed tune.abc is a human score too: generate.mjs owns output/composition/score.musicxml then
    human_score = next((p for p in (pkg / "sources" / "score.musicxml", pkg / "sources" / "tune.abc") if p.exists()),
                       pkg / "sources" / "score.musicxml")
    comp = pkg / "output" / "composition"
    lyrics = pkg / "sources" / "lyrics.chordpro"
    vocals = next(iter(stems_dir.glob("*_vocals.m4a")), None) or next(iter(stems_dir.glob("*vocals*")), None)
    sketch = comp / "score.musicxml"
    # ponytail: reuse the sketch unless the recording or the words changed; --force re-transcribes
    sketch_fresh = sketch.exists() and mtime(sketch) > max(mtime(vocals) if vocals else 0, mtime(lyrics) if lyrics.exists() else 0)
    if not human_score.exists() and sketch_fresh and not force:
        score_src = sketch  # transcription is the slow step; reuse it when nothing it reads has changed
    elif not human_score.exists() and vocals and lyrics.exists():
        print(f"  transcribe {vocals.name} -> MIDI/MusicXML", flush=True)
        try:
            sys.path.insert(0, str(HERE))
            from stems_to_score import transcribe
            info = transcribe(vocals, lyrics, comp, song.get("bpm"), stems_dir=stems_dir, mix=master)
            onset = info.get("vocal_onset")
            sheet = "" if info.get("sheet") else " (MusicXML only; no SVG/PDF renderer)"
            vocal = f", vocal@{onset}s" if onset is not None else ""
            print(
                f"  {info['notes']} melody notes, {info.get('midi_notes', info['notes'])} midi notes, "
                f"{info['key']} @ {info['bpm']} bpm{vocal}{sheet}",
                flush=True,
            )
            score_src = comp / "score.musicxml"
            tune = pkg / "sources" / "tune.mid"
            if tune.exists():  # policy: the writer's MIDI ships as score.mid; the sketch only feeds notation
                shutil.copy2(tune, comp / "score.mid")
            _maybe_stamp_detected(pkg, song, info)
            shutil.copy2(pkg / "song.json", work / "masters" / "song.json")  # stamped key/bpm name the pack
        except Exception as e:
            print(f"  transcribe failed ({type(e).__name__}: {e}); pack continues without a score", flush=True)
    if not song.get("bpm"):
        raise Skip("song.json has no bpm and none was detected from the recording; the click track needs it")
    if score_src:
        shutil.copy2(score_src, work / "masters" / "score.musicxml")
    else:
        stub_score(work / "masters" / "score.musicxml", song, duration_seconds(master))

    bounce = stems_dir / f"{master.stem}_bounce.m4a"
    if not bounce.exists() or mtime(bounce) < mtime(master):
        print("  bounce (click + callouts)", flush=True)
        run([sys.executable, str(HERE / "make_bounce.py"), str(work / master.name)], env)

    staging = work / "pack"
    if staging.exists():
        shutil.rmtree(staging)
    run([sys.executable, str(HERE / "generate_multitracks.py"),
         "--from-stems", "--real-only", "--no-zip", "--format", fmt, "--out", str(staging)], env)

    pack_dir = next((p for p in staging.iterdir() if p.is_dir()), None)
    if pack_dir is None:
        raise RuntimeError("generator produced no pack folder")
    licence = pkg / "output" / "composition" / "LICENSE.txt"
    if not licence.exists():
        raise RuntimeError("output/composition/LICENSE.txt is missing; run node tools/generate.mjs first")
    shutil.copy2(licence, pack_dir / "LICENSE.txt")

    # output/audio ships the pack zip plus its sidecars: full mix, 30 s preview, instrumental bed.
    # The extracted pack folder is an intermediate and stays in the cache.
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    zip_path = out / f"{pack_dir.name}.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for p in sorted(pack_dir.rglob("*")):
            if p.is_file():
                # contents at the zip root: unzipping already puts them in a folder
                z.write(p, p.relative_to(pack_dir).as_posix())
    for m4a in staging.glob("*.m4a"):
        shutil.move(str(m4a), out / m4a.name)

    prune(work)
    return f"built {zip_path.name} ({zip_path.stat().st_size / 1e6:.0f} MB)"


def write_audio_zip(pkg: Path, master: Path) -> str:
    """output/audio.zip: master, full mix, instrumental bed, sources/extra/*, license + attribution.
    Not the multitracks (their own zip) and not the 30 s preview. Root-level entries, no folder."""
    comp = pkg / "output" / "composition"
    audio = pkg / "output" / "audio"
    files = [master, *audio.glob("*-fullmix.m4a"), audio / "instrumental.m4a",
             *sorted((pkg / "sources" / "extra").glob("*")), comp / "LICENSE.txt", comp / "attribution.txt"]
    files = [p for p in files if p.is_file()]
    zip_path = pkg / "output" / "audio.zip"
    if zip_path.exists() and mtime(zip_path) >= max(mtime(p) for p in files):
        return "audio.zip up to date"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.name)
    return f"wrote audio.zip ({zip_path.stat().st_size / 1e6:.0f} MB)"


def run(cmd: list[str], env: dict) -> None:
    r = subprocess.run(cmd, env=env, cwd=str(HERE))
    if r.returncode:
        raise RuntimeError(f"{Path(cmd[1]).name} exited {r.returncode}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", nargs="?", default=".", help="package, language folder, or the repo root")
    ap.add_argument("-f", "--force", action="store_true", help="rebuild even when the pack is up to date")
    ap.add_argument("-n", "--dry-run", action="store_true", help="report what would build, touch nothing")
    ap.add_argument("--format", choices=("m4a", "ogg", "flac", "wav"), default="ogg",
                    help="pack audio format. ogg (default), flac and wav are native to Live; m4a needs an external codec")
    args = ap.parse_args()

    target = Path(args.target)
    if not target.is_absolute():
        target = (ROOT / args.target).resolve() if (ROOT / args.target).exists() else target.resolve()
    if not target.exists():
        sys.exit(f"no such folder: {args.target}")

    built = skipped = failed = 0
    for pkg in packages(target):
        label = pkg.relative_to(ROOT).as_posix() if pkg.is_relative_to(ROOT) else str(pkg)
        try:
            song, master, _row = gate(pkg)
        except Skip as e:
            if str(e) != "no master recording":
                print(f"SKIP  {label}: {e}", flush=True)
                skipped += 1
            continue
        except Exception as e:  # unreadable package — say so, keep going
            print(f"ERROR {label}: {type(e).__name__}: {e}", flush=True)
            failed += 1
            continue
        if args.dry_run:
            print(f"would build {label} from sources/master/{master.name}", flush=True)
            built += 1
            continue
        print(f"pack  {label}", flush=True)
        try:
            print(f"  {build(pkg, song, master, args.force, args.format)}", flush=True)
            print(f"  {write_audio_zip(pkg, master)}", flush=True)
            # chords: the writer's chart when the harvest found one, else derived from the sketch MIDI
            run([sys.executable, str(HERE / "derive_chords.py"), str(pkg), "--write"], dict(os.environ))
            # the sketch score and any derived chords belong in composition.zip: rebuild it
            run(["node", str(ROOT / "tools" / "generate.mjs"), str(pkg)], dict(os.environ))
            built += 1
        except Exception as e:
            print(f"ERROR {label}: {type(e).__name__}: {e}", flush=True)
            failed += 1
    print(f"packs: {built} built, {skipped} skipped, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
