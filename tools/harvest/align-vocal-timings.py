"""Align ChordPro lyrics onto a writer MP3 using faster-whisper word timestamps.

The ABC/MIDI karaoke generator (generate-lyric-timings.py) times hymns to the
synthesized tune. Writer recordings have an intro and a sung tempo the MIDI
does not share, so Lead worship drifted 10–15s. This stamps sources/timing.json
from the vocal track instead.

  python tools/harvest/align-vocal-timings.py
  python tools/harvest/align-vocal-timings.py songs/en/current-pEDCgbBehcH
  python tools/harvest/align-vocal-timings.py --only "Christ Alive in Me"
  python tools/harvest/align-vocal-timings.py --force

The recording is the package's sources/master/ file (any format), else the writer's
demo (sources/demoAudio.*); when pack/build.py
has separated it, the cached vocal stem is transcribed instead (no band under the
words). English uses small.en, other languages the multilingual small model with
the language from the package folder. tools/publish-approved.mjs runs this for every
approved song with a master.

Needs: faster-whisper, ffprobe. Skips a song rather than write a bad file when too
few lyric words match the transcription.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SECTION_HEADING = re.compile(
    r"^(verse\s*\d*|chorus\s*\d*|bridge\s*\d*|refrain|pre[- ]?chorus|"
    r"intro(?:duction)?|outro|tag|interlude|ending|coda|instrumental)$",
    re.I,
)
# tools/lib.mjs SECTION_LABEL: a heading word at the start ("Chorus3", "CHORUS (2x)")
# a bare "PRE" (or "Pre 2:") shortens the pre-chorus; only alone, so "Precious" stays a lyric
LABEL_START = re.compile(r"^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus|pre(?=\s*\d*\s*:?\s*$)|interlude|instrumental|turnaround)(?:\b|(?=\d))", re.I)
REPEAT_MARK = re.compile(r"^\(?\s*(?:x\s*\d+|\d+\s*x|repeat\b.*)\s*\)?$", re.I)
COMMENT_DIRECTIVE = re.compile(r"^\s*\{\s*(?:c|ci|comment|comment_italic)\s*:\s*(.+?)\s*\}\s*$", re.I)


def tidy_label(label: str) -> str:
    """"Verse 1:" and "CHORUS: (2x)" name the same sections as "Verse 1" and "CHORUS (2x)"."""
    return re.sub(r"\s+", " ", re.sub(r":(?=\s|$)", "", label)).strip()
CHORD = re.compile(r"\[[^\]]*\]")
TODAY = date.today().isoformat()


def norm(w: str) -> str:
    return re.sub(r"[^a-z0-9]", "", w.lower())


def label_of(line: str) -> str | None:
    """A stanza label (tools/lib.mjs sectionLabelOf): a known heading ("Chorus3", "Verse 1:"), a ChordPro comment
    ("{c: Intro}"), or a chord-free line wholly in parentheses ("(Chorus x2)"), labelled by the text inside without a
    trailing colon. None for a sung line."""
    comment = COMMENT_DIRECTIVE.match(line)
    if comment:
        return tidy_label(comment.group(1)) or None
    plain = CHORD.sub("", line).strip()
    if not CHORD.search(line):
        m = re.fullmatch(r"\((.+)\)", plain)
        if m:
            return tidy_label(m.group(1))
    return tidy_label(plain) if LABEL_START.match(plain) else None


def parse_stanzas(chordpro: str) -> list[dict]:
    blocks = re.split(r"\r?\n\s*\r?\n", chordpro or "")
    stanzas: list[dict] = []
    for block in blocks:
        # {directives} are cues, not lyrics — except a {c: Chorus} comment, which labels its stanza
        lines = [ln for ln in block.splitlines() if ln.strip() and (not ln.strip().startswith("{") or label_of(ln))]
        if not lines:
            continue
        # a block that opens with a sung line has no label: never spend a lyric on one
        label = label_of(lines[0])
        body = lines[1:] if label else lines
        prev = stanzas[-1] if stanzas else None
        # "(Bridge)" over a chord line, a blank line, then the bridge's words: the unlabelled block is that section's
        if not label and prev and prev["label"] and not any(CHORD.sub("", ln).strip() for ln in prev["lines"]):
            prev["lines"].extend(body)
        else:
            stanzas.append({"label": label or "", "lines": body})
    if any(s["lines"] for s in stanzas):
        return stanzas
    out: list[dict] = []
    for s in stanzas:
        label = s["label"]
        if label.startswith("{") or label.startswith(">"):
            continue
        if SECTION_HEADING.match(label):
            out.append({"label": label, "lines": []})
            continue
        if not out:
            out.append({"label": "Lyrics", "lines": []})
        out[-1]["lines"].append(label)
    return out


def lyric_tokens(stanzas: list[dict]) -> list[dict]:
    tokens = []
    for si, st in enumerate(stanzas):
        for li, line in enumerate(st["lines"]):
            # a stage direction in parentheses, or a repeat mark ("4x", "x2", "Repeat"): not sung
            if (line.strip().startswith("(") and line.strip().endswith(")")) or REPEAT_MARK.match(CHORD.sub("", line).strip()):
                tokens.append({"si": si, "li": li, "text": line.strip(), "n": "", "dir": True})
                continue
            for w in CHORD.sub("", line).split():
                n = norm(w)
                if n:
                    tokens.append({"si": si, "li": li, "text": w, "n": n, "dir": False})
    return tokens


def transcribe(model, mp3: Path, lang: str) -> list[dict]:
    segs, _ = model.transcribe(str(mp3), language=lang, word_timestamps=True, vad_filter=False)
    out = []
    for seg in segs:
        for w in seg.words or []:
            text = (w.word or "").strip()
            n = norm(text)
            if not n:
                continue
            start, end = float(w.start), float(w.end)
            out.append({"t": start, "d": max(0.05, end - start), "text": text, "n": n})
    return out


def align(lyrics: list[dict], asr: list[dict]) -> list[int | None]:
    """Map each sung lyric token to an ASR index. Stage directions stay None."""
    sung = [(i, tok) for i, tok in enumerate(lyrics) if not tok["dir"]]
    if not sung or not asr:
        return [None] * len(lyrics)
    n, m = len(sung), len(asr)
    # cost[i][j] = best for first i sung words vs first j asr words
    INF = 10**9
    cost = [[INF] * (m + 1) for _ in range(n + 1)]
    bt = [[None] * (m + 1) for _ in range(n + 1)]  # ("m",) ("s",) ("a",)
    cost[0][0] = 0
    for j in range(1, m + 1):
        cost[0][j] = j
        bt[0][j] = "a"
    for i in range(1, n + 1):
        cost[i][0] = i * 2
        bt[i][0] = "s"
        a = sung[i - 1][1]["n"]
        for j in range(1, m + 1):
            b = asr[j - 1]["n"]
            match = cost[i - 1][j - 1] + (0 if a == b else (1 if a[:3] == b[:3] else 3))
            skip_s = cost[i - 1][j] + 2
            skip_a = cost[i][j - 1] + 1
            best = min(match, skip_s, skip_a)
            cost[i][j] = best
            bt[i][j] = "m" if best == match else ("s" if best == skip_s else "a")
    i, j = n, m
    asr_of = [None] * n
    while i > 0 or j > 0:
        op = bt[i][j]
        if op == "m":
            asr_of[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif op == "s":
            i -= 1
        else:
            j -= 1
    mapped: list[int | None] = [None] * len(lyrics)
    for k, (li, _) in enumerate(sung):
        mapped[li] = asr_of[k]
    return mapped


def fill_times(lyrics: list[dict], asr: list[dict], mapped: list[int | None], duration: float) -> None:
    last = 0.0
    for i, tok in enumerate(lyrics):
        j = mapped[i]
        if j is not None:
            tok["t"] = asr[j]["t"]
            tok["d"] = asr[j]["d"]
            last = tok["t"] + tok["d"]
        else:
            tok["t"] = None
            tok["d"] = None
    # interpolate unmatched (including stage directions) between neighbors
    n = len(lyrics)
    for i, tok in enumerate(lyrics):
        if tok["t"] is not None:
            continue
        prev = next((lyrics[k] for k in range(i - 1, -1, -1) if lyrics[k]["t"] is not None), None)
        nxt = next((lyrics[k] for k in range(i + 1, n) if lyrics[k]["t"] is not None), None)
        if prev and nxt:
            tok["t"] = (prev["t"] + nxt["t"]) / 2
            tok["d"] = max(0.08, (nxt["t"] - prev["t"]) / 2)
        elif prev:
            tok["t"] = prev["t"] + prev["d"]
            tok["d"] = 0.2
        elif nxt:
            tok["t"] = max(0.0, nxt["t"] - 0.3)
            tok["d"] = 0.2
        else:
            tok["t"] = 0.0
            tok["d"] = 0.4
    for i in range(n - 1):
        gap = lyrics[i + 1]["t"] - lyrics[i]["t"]
        if gap > 0:
            lyrics[i]["d"] = min(lyrics[i]["d"], gap)
    if lyrics:
        lyrics[-1]["d"] = min(lyrics[-1]["d"], max(0.1, duration - lyrics[-1]["t"]))


def build_json(stanzas: list[dict], lyrics: list[dict], duration: float) -> dict:
    by: dict[tuple[int, int], list] = {}
    for tok in lyrics:
        by.setdefault((tok["si"], tok["li"]), []).append(
            {"t": round(tok["t"], 3), "d": round(max(0.05, tok["d"]), 3), "text": tok["text"]}
        )
    out = []
    for si, st in enumerate(stanzas):
        lines = []
        for li, _ in enumerate(st["lines"]):
            words = by.get((si, li), [])
            if words:
                lines.append(words)
        if lines:
            out.append({"label": st["label"], "lines": lines})
    return {"duration": round(duration, 3), "stanzas": out, "basis": "vocal"}


def mp3_duration(path: Path) -> float:
    import subprocess
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())


def stamp_manifest(src: Path, timing: Path) -> None:
    man_path = src / "manifest.json"
    man = json.loads(man_path.read_text(encoding="utf-8")) if man_path.exists() else {"files": []}
    sha = hashlib.sha256(timing.read_bytes()).hexdigest()
    row = {
        "file": "timing.json",
        "url": None,
        "acquired": TODAY,
        "sha256": sha,
        "licenseBasis": "worshipcommons",
        "original": False,
        "submittedBy": None,
        "note": "Word timings aligned to the writer recording (faster-whisper)",
        "layer": "text",
        "obtainedVia": "generated",
    }
    files = [f for f in man.get("files", []) if f.get("file") != "timing.json"]
    files.append(row)
    man["files"] = files
    man_path.write_text(json.dumps(man, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


AUDIO_EXT = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aiff", ".aif", ".opus"}


def package_mp3(dir: Path, song: dict) -> Path | None:
    """The recording Lead Worship plays: the master in sources/master/, else the writer's demo (sources/demoAudio.*)."""
    src, master = dir / "sources", dir / "sources" / "master"
    name = (song.get("uploads") or {}).get("demoAudio")
    for p in ([master / name, src / name] if name else []):
        if p.exists():
            return p
    for p in sorted(master.glob("*")) if master.exists() else []:
        if p.is_file() and p.suffix.lower() in AUDIO_EXT:
            return p
    for p in sorted(src.glob("demoAudio.*")):
        if p.suffix.lower() in AUDIO_EXT:
            return p
    return None


def vocal_stem(dir: Path) -> Path | None:
    """pack/build.py's separated vocals for this package, when its cache still holds them (same timeline as the master)."""
    for p in sorted((ROOT / "tools" / ".cache" / "pack" / dir.name / "stems_out").glob("*_vocals.*")):
        return p
    return None


def whisper_for(lang: str, holder: dict):
    """small.en for English, the multilingual small model for anything else; each loaded once."""
    key = "small.en" if lang == "en" else "small"
    if key not in holder:
        print(f"  loading whisper {key}…")
        from faster_whisper import WhisperModel
        holder[key] = WhisperModel(key, device="cpu", compute_type="int8")
    return holder[key]


def lyrics_body(dir: Path) -> str:
    p = dir / "sources" / "lyrics.chordpro"
    if not p.exists():
        p = dir / "masters" / "lyrics.chordpro"
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8")
    lines = text.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith("{"):
        i += 1
    if i < len(lines) and lines[i] == "":
        i += 1
    return "\n".join(lines[i:])


def process(dir: Path, song: dict, model_holder: dict, force: bool) -> str:
    timing_path = dir / "sources" / "timing.json"
    if timing_path.exists() and not force:
        data = json.loads(timing_path.read_text(encoding="utf-8"))
        if data.get("basis") == "vocal":
            return "have"
    mp3 = package_mp3(dir, song)
    if not mp3:
        return "no-mp3"
    body = lyrics_body(dir)
    stanzas = parse_stanzas(body)
    tokens = lyric_tokens(stanzas)
    sung = [t for t in tokens if not t["dir"]]
    if len(sung) < 8:
        return "too-few-lyrics"
    lang = dir.parent.name  # songs/<lang>/<slug>-<id>
    dur = mp3_duration(mp3)
    asr = transcribe(whisper_for(lang, model_holder), vocal_stem(dir) or mp3, lang)
    if len(asr) < 8:
        return "no-asr"
    mapped = align(tokens, asr)
    hits = sum(1 for t, j in zip(tokens, mapped) if not t["dir"] and j is not None)
    ratio = hits / max(1, len(sung))
    if ratio < 0.45:
        return f"low-match {ratio:.0%}"
    fill_times(tokens, asr, mapped, dur)
    payload = build_json(stanzas, tokens, dur)
    if not payload["stanzas"]:
        return "empty"
    timing_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    stamp_manifest(dir / "sources", timing_path)
    return f"ok {ratio:.0%} {len(sung)}w"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", nargs="?", help="one song package (songs/<lang>/<slug>-<id>); default every package")
    ap.add_argument("--only", help="song title substring")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    model_holder: dict = {}
    stats: dict[str, int] = {}
    paths = [Path(args.target).resolve() / "song.json"] if args.target else sorted((ROOT / "songs").glob("*/*/song.json"))
    for song_path in paths:
        if not song_path.exists():
            continue
        song = json.loads(song_path.read_text(encoding="utf-8"))
        if args.only and args.only.lower() not in (song.get("title") or "").lower():
            continue
        dir = song_path.parent
        if not package_mp3(dir, song):
            continue
        print(f"  {song.get('title')}…", flush=True)
        try:
            result = process(dir, song, model_holder, args.force)
        except Exception as e:
            result = f"err {e}"
        print(f"    {result}")
        key = result.split()[0]
        stats[key] = stats.get(key, 0) + 1
    print("stats", stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
