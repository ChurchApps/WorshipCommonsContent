"""Fill inline chords into sources/lyrics.chordpro from a PD SATB ABC.

Walks the content library. Skips songs that already have chords, or whose
lyrics will not align to the ABC. Output stays PD (harmony from Open Hymnal).

  python tools/harvest/backfill-library-chords.py [--only slug]
  python tools/harvest/backfill-library-chords.py --expand [--dry-run] [--only slug]

--expand appends verses that the ABC already underlays but the ChordPro seed
omitted (the original mockup charts often held verse 1 only). Existing lines
are left alone. First-verse text must match the ABC so a borrowed tune cannot
donate another hymn's remaining stanzas. New verses keep the seed chart's
chords (same meter, congregational key) rather than SATB chordify. Then:
node tools/generate.mjs <pkg> and node tools/build-catalog.mjs && node tools/validate.mjs.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ABC2XML = ROOT / "tools" / "vendor" / "abc2xml.py"
PYTHON = os.environ.get("PYTHON", sys.executable)
BLOCK_LIC = {"larry-holder"}
SECTION = re.compile(
    r"^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus|"
    r"estrofa|coro|estribillo|strophe|kehrvers)\b",
    re.I,
)

SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
FLAT_KEYS = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Dm", "Gm", "Cm", "Fm", "Bbm"}
QUALITIES = [
    ((0, 4, 7, 10), "7"), ((0, 3, 7, 10), "m7"), ((0, 4, 7, 11), "maj7"),
    ((0, 4, 7), ""), ((0, 3, 7), "m"), ((0, 3, 6), "dim"), ((0, 4, 8), "aug"),
]
CHORD = re.compile(r"\[[A-G][#b]?")
STRIP = re.compile(r"^\d+\.\s*")
PASSING = ("dim", "aug")
EXPAND = "--expand" in sys.argv
DRY = "--dry-run" in sys.argv
ONLY = None
for i, a in enumerate(sys.argv):
    if a == "--only" and i + 1 < len(sys.argv):
        ONLY = sys.argv[i + 1]


def chord_name(pcs, bass_pc, flats):
    names = FLAT if flats else SHARP
    best = None
    for root in sorted(pcs):
        rel = frozenset((p - root) % 12 for p in pcs)
        for ivs, suffix in QUALITIES:
            covered = rel & set(ivs)
            if 0 not in covered or rel - set(ivs):
                continue
            score = (len(covered), root == bass_pc, -len(ivs))
            if best is None or score > best[0]:
                best = (score, names[root] + suffix)
    return best[1] if best else None


def analyze(abc_path: Path):
    from music21 import converter, stream, meter
    with tempfile.TemporaryDirectory() as td:
        r = subprocess.run([PYTHON, str(ABC2XML), "-o", td, str(abc_path)], capture_output=True, text=True)
        xml = next(Path(td).glob("*.xml"), None)
        if r.returncode != 0 or not xml:
            raise RuntimeError((r.stderr or r.stdout or "abc2xml failed")[-400:])
        score = converter.parse(str(xml))
    slices = []
    for c in score.chordify().flatten().notes:
        slices.append((
            float(c.offset),
            {p.pitch.pitchClass for p in c.notes} if hasattr(c, "notes") else {p.pitchClass for p in c.pitches},
            min(p.midi for p in c.pitches) % 12,
        ))
    slices.sort()
    bars, beats = [], []
    part0 = score.parts[0] if score.parts else score
    for m in part0.getElementsByClass(stream.Measure):
        ts = m.getContextByClass(meter.TimeSignature)
        bar = float(ts.barDuration.quarterLength) if ts else 4.0
        step = float(ts.beatDuration.quarterLength) if ts else 1.0
        off = float(m.offset)
        bars.append(off)
        b = 0.0
        while b < bar - 1e-6:
            beats.append(off + b)
            b += step
    bars.sort(); beats.sort()
    # Open Hymnal SATB is often one staff of chords ([Ac] etc.); lyrics sit on
    # the chord, not a single Note. Keep any pitched event that carries lyrics.
    melody = [n for n in part0.flatten().notes if n.lyrics]
    melody.sort(key=lambda n: float(n.offset))
    return slices, bars, beats, melody


def chord_at(slices, offset):
    active = None
    for off, pcs, bass in slices:
        if off > offset + 1e-6:
            break
        active = (pcs, bass)
    return active


def norm_word(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def build_streams(slices, bars, beats, melody, flats):
    import bisect
    bar_set = set(bars)
    streams = {}
    for n in melody:
        off = float(n.offset)
        i = bisect.bisect_right(beats, off + 1e-6) - 1
        sample = beats[i] if i >= 0 else off
        active = chord_at(slices, sample)
        sym = chord_name(active[0], active[1], flats) if active else None
        if sym and sym.endswith(PASSING) and sample not in bar_set:
            j = bisect.bisect_right(bars, off + 1e-6) - 1
            active = chord_at(slices, bars[j]) if j >= 0 else active
            sym = chord_name(active[0], active[1], flats) if active else None
        for lyr in n.lyrics:
            if not lyr.text:
                continue
            text = STRIP.sub("", lyr.text).replace("~", " ")
            if not re.sub(r"[^A-Za-z0-9]", "", text):
                continue
            st = streams.setdefault(lyr.number, {"words": [], "last": None, "open": False})
            chord = sym if sym and sym != st["last"] else None
            if chord:
                st["last"] = sym
            dur = float(n.duration.quarterLength)
            if st["open"] and st["words"]:
                st["words"][-1].append((chord, text, off, dur))
            else:
                st["words"].append([(chord, text, off, dur)])
            st["open"] = lyr.syllabic in ("begin", "middle")
    return {k: v["words"] for k, v in streams.items()}


def syl_text(item):
    return item[1]


def render_line(words):
    return " ".join("".join((f"[{c}]" if c else "") + s for c, s, *_ in word) for word in words)


def align_line(lw, words, cur):
    W = words[cur:cur + len(lw) + 4]
    wnorm = [norm_word("".join(syl_text(p) for p in w)) for w in W]
    lnorm = [norm_word(a) for a in lw]

    @lru_cache(maxsize=None)
    def dp(i, j):
        if i == len(lw):
            return 0, ()
        best = None
        if j < len(W):
            c, ops = dp(i + 1, j + 1)
            cand = (c + (0 if lnorm[i] == wnorm[j] else 1), (("m", i, j),) + ops)
            best = cand if best is None or cand < best else best
        if j + 1 < len(W) and lnorm[i] == wnorm[j] + wnorm[j + 1]:
            c, ops = dp(i + 1, j + 2)
            cand = (c, (("g", i, j),) + ops)
            best = cand if best is None or cand < best else best
        if j < len(W):
            c, ops = dp(i, j + 1)
            cand = (c + 1, (("sw", i, j),) + ops)
            best = cand if best is None or cand < best else best
        c, ops = dp(i + 1, j)
        cand = (c + 1, (("sl", i, j),) + ops)
        return cand if best is None or cand < best else best

    cost, ops = dp(0, 0)
    if cost > max(1, len(lw) // 5):
        return None
    rendered, consumed = [], 0
    for op, i, j in ops:
        if op == "m":
            rendered.append(W[j]); consumed = j + 1
        elif op == "g":
            rendered.append(W[j] + W[j + 1]); consumed = j + 2
        elif op == "sw":
            consumed = j + 1
        else:
            rendered.append([(None, lw[i])])
    return cost, rendered, cur + consumed


def annotate(chord_pro, streams):
    stanzas = chord_pro.split("\n\n")
    cursors = {k: 0 for k in streams}
    out_stanzas = []
    for stanza in stanzas:
        lines = stanza.split("\n")
        label, body = lines[0], lines[1:]
        vm = re.match(r"Verse (\d+)$", label)
        new_body = []
        for line in body:
            lw = line.split()
            cands = [int(vm.group(1))] if vm else sorted(streams)
            best = None
            for k in cands:
                if k not in streams:
                    continue
                a = align_line(lw, streams[k], cursors[k])
                if a and (best is None or a[0] < best[0][0]):
                    best = (a, k)
            if best is None:
                for k in cands:
                    if k not in streams:
                        continue
                    for start in range(len(streams[k])):
                        a = align_line(lw, streams[k], start)
                        if a and a[0] == 0:
                            if best is None or a[0] < best[0][0]:
                                best = (a, k)
                            break
            if best is None:
                return None
            (_, rendered, new_cur), k = best
            new_body.append(render_line(rendered))
            cursors[k] = new_cur
        out_stanzas.append("\n".join([label] + new_body))
    return "\n\n".join(out_stanzas)


def split_chordpro(text: str):
    lines = text.replace("\n$", "").rstrip("\n").split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith("{"):
        i += 1
    if i < len(lines) and lines[i] == "":
        i += 1
    return "\n".join(lines[:i]).rstrip("\n"), "\n".join(lines[i:])


def find_abc(song_dir: Path, parent_id: str | None) -> Path | None:
    """The song's own ABC, else its parent's (a translation shares the tune)."""
    own = song_dir / "sources" / "tune.abc"
    if own.exists():
        return own
    if parent_id:
        for p in (ROOT / "songs").glob(f"*/*-{parent_id}/sources/tune.abc"):
            return p
    return None


JUNK_VERSE = re.compile(
    r"insert appropriate|\$\d|^\s*\d+-\d+\.|spotless raiment|sacred throng",
    re.I,
)


def strip_chord_marks(s: str) -> str:
    return re.sub(r"\[[^\]]*\]", "", s)


def stanza_lines(body: str, want: str | None = "verse 1") -> list[str]:
    for stanza in body.split("\n\n"):
        lines = [l for l in stanza.split("\n") if l.strip()]
        if not lines:
            continue
        label = strip_chord_marks(lines[0]).strip()
        if SECTION.match(label):
            if want and not re.match(want + r"\b", label, re.I):
                continue
            return lines[1:]
        if want is None or want == "verse 1":
            return lines
    return []


def first_stanza_words(body: str) -> list[str]:
    lines = stanza_lines(body, "verse 1") or stanza_lines(body, None)
    return [w for line in lines for w in strip_chord_marks(line).split()]


def clean_abc_lyric(line: str) -> str:
    s = re.sub(r"^w:\s*", "", line, flags=re.I)
    s = re.sub(r"^\d+\.\s*~?\s*", "", s)
    s = re.sub(r"!\w+!", "", s)
    s = re.sub(r"[*_|\\]", "", s)
    s = s.replace("~", " ")
    s = re.sub(r"([A-Za-z])-\s+", r"\1", s)
    s = re.sub(r"([,.;:!?])-\s*", r"\1 ", s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    return s.strip()


def parse_abc_verses(text: str) -> list[list[str]]:
    melody_voice = ""
    m = re.search(r"%%staves\s*\(?\s*(\S+?)[\s)]", text)
    if m:
        melody_voice = m.group(1)
    current = ""
    groups, group = [], None
    for l in text.splitlines():
        vm = re.match(r"^\[V:\s*(\S+?)\]", l)
        if vm:
            current = vm.group(1)
            if not melody_voice:
                melody_voice = current
            if current == melody_voice:
                group = []
                groups.append(group)
            continue
        if re.match(r"^w:", l) and current == melody_voice and group is not None:
            c = clean_abc_lyric(l)
            if c:
                group.append(c)
    non_empty = [g for g in groups if g]
    if not non_empty:
        return []
    verse_count = max(len(g) for g in non_empty)
    verses = [[] for _ in range(verse_count)]
    for g in non_empty:
        if len(g) == verse_count:
            for i, line in enumerate(g):
                verses[i].append(line)
    return [v for v in verses if any(x.strip() for x in v)]


def texts_match_lines(cp_words: list[str], abc_lines: list[str]) -> bool:
    import difflib
    if not cp_words or not abc_lines:
        return False
    a = "".join(norm_word(w) for w in cp_words[:10])
    b = "".join(norm_word(w) for line in abc_lines for w in line.split())[: len(a) + 16]
    return bool(a) and (a in b or difflib.SequenceMatcher(None, a, b[: len(a) + 10]).ratio() > 0.8)


def split_at_mid(phrase: str) -> tuple[str, str] | None:
    phrase = phrase.strip()
    if len(phrase.split()) < 4:
        return None
    mid = len(phrase) // 2
    punct = [
        i for i, ch in enumerate(phrase)
        if ch in ",;:" and len(phrase[:i].split()) >= 4 and len(phrase[i + 1 :].split()) >= 4
    ]
    if punct:
        i = min(punct, key=lambda x: abs(x - mid))
        if abs(i - mid) <= max(12, len(phrase) // 5):
            left, right = phrase[: i + 1].strip(), phrase[i + 1 :].strip()
            if left and right:
                return left, right
    words = phrase.split()
    midw = max(2, len(words) // 2)
    return " ".join(words[:midw]), " ".join(words[midw:])


def reflow_lines(text: str, n: int) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if n <= 1 or not text:
        return [text] if text else []
    phrases = [p.strip() for p in re.split(r"(?<=[;:.])\s+", text) if p.strip()]
    if not phrases:
        return [text]
    merged = []
    for p in phrases:
        if merged and len(merged[-1].split()) < 4:
            merged[-1] = merged[-1] + " " + p
        else:
            merged.append(p)
    if len(merged) >= 2 and len(merged[-1].split()) < 4:
        merged[-2] = merged[-2] + " " + merged[-1]
        merged.pop()
    phrases = merged
    while len(phrases) > n:
        i = min(range(len(phrases) - 1), key=lambda j: len(phrases[j]) + len(phrases[j + 1]))
        phrases[i] = phrases[i] + " " + phrases[i + 1]
        del phrases[i + 1]
    while len(phrases) < n:
        i = max(range(len(phrases)), key=lambda j: len(phrases[j].split()))
        parts = split_at_mid(phrases[i])
        if not parts:
            break
        phrases[i : i + 1] = list(parts)
    return phrases


def trim_to_v1(text: str, v1_words: int) -> str:
    words = text.split()
    if not v1_words or len(words) <= int(v1_words * 1.25):
        return text
    acc = []
    lo = max(8, int(v1_words * 0.85))
    for w in words:
        acc.append(w)
        if len(acc) >= lo and re.search(r"[.;:!?]$", w):
            return " ".join(acc)
        if len(acc) >= int(v1_words * 1.2):
            return " ".join(acc)
    return " ".join(words[:v1_words])


def chord_words(line: str) -> list[tuple[str | None, str]]:
    s = re.sub(r"([^\s\[]*)\[([^\]]+)\]([^\s\[]*)", lambda m: f"[{m.group(2)}]{m.group(1)}{m.group(3)}", line)
    out, pending = [], None
    for tok in s.split():
        m = re.match(r"^\[([^\]]+)\](.*)$", tok)
        if m:
            ch, rest = m.group(1), m.group(2)
            if rest:
                out.append((ch, rest))
                pending = None
            else:
                pending = ch
        else:
            out.append((pending, tok))
            pending = None
    return out


def overlay_line(template: str, lyric: str) -> str:
    tw = chord_words(template)
    lw = lyric.split()
    if not tw or not lw:
        return lyric
    out = []
    last = None
    for i, w in enumerate(lw):
        j = round(i * (len(tw) - 1) / max(len(lw) - 1, 1)) if len(lw) > 1 else 0
        ch = tw[min(j, len(tw) - 1)][0]
        if ch and ch != last:
            out.append(f"[{ch}]{w}")
            last = ch
        else:
            out.append(w)
    return " ".join(out)


def overlay_verse(v1_lines: list[str], lyric_lines: list[str]) -> list[str]:
    n = len(v1_lines)
    v1w = sum(len(strip_chord_marks(l).split()) for l in v1_lines)
    text = trim_to_v1(" ".join(lyric_lines), v1w)
    sentences = len(lyric_lines) >= 2 and all(re.search(r"[.!?]$", l.strip()) for l in lyric_lines)
    if sentences and sum(len(l.split()) for l in lyric_lines) <= int(v1w * 1.35):
        lines = lyric_lines
    else:
        lines = reflow_lines(text, n or 1)
    if n and len(lines) == n:
        return [overlay_line(v1_lines[i], lines[i]) for i in range(n)]
    return [overlay_line(v1_lines[min(i, n - 1)], line) for i, line in enumerate(lines)] if v1_lines else lines


def verse_ok(v1_lines: list[str], lines: list[str]) -> bool:
    if not lines or any(JUNK_VERSE.search(l) for l in lines):
        return False
    if any(len(strip_chord_marks(l).split()) < 4 for l in lines):
        return False
    w = sum(len(l.split()) for l in lines)
    w1 = sum(len(strip_chord_marks(l).split()) for l in v1_lines) or 1
    return 0.7 * w1 <= w <= 1.45 * w1


def chordpro_verse_nums(body: str) -> set[int]:
    nums = {int(n) for n in re.findall(r"(?im)^Verse\s+(\d+)\s*$", body)}
    if nums:
        return nums
    return {1} if body.strip() else set()


def already_has_text(body: str, lines: list[str]) -> bool:
    have = re.sub(r"[^a-z0-9]+", "", strip_chord_marks(body).lower())
    added = re.sub(r"[^a-z0-9]+", "", strip_chord_marks(" ".join(lines)).lower())
    return bool(added) and added in have


def draft_form(body: str, status: str = "draft") -> dict | None:
    labels = []
    for line in body.split("\n"):
        t = re.sub(r"\[[^\]]*\]", "", line).strip()
        if t and SECTION.match(t):
            labels.append(t)
    if not labels:
        return None
    seen = {}
    sections = []
    lyric = 0
    for label in labels:
        if label not in seen:
            lyric += 1
            seen[label] = lyric
            sections.append({"label": label, "lyric": lyric})
    return {"status": status, "sections": sections, "defaultOrder": labels}


def bump_lyrics_manifest(pkg: Path, note: str):
    mp = pkg / "sources" / "manifest.json"
    data = json.loads(mp.read_text(encoding="utf-8")) if mp.exists() else {"files": []}
    rows = data.get("files") or []
    p = pkg / "sources" / "lyrics.chordpro"
    sha = hashlib.sha256(p.read_bytes()).hexdigest()
    row = next((r for r in rows if r.get("file") == "lyrics.chordpro"), None)
    if row is None:
        row = {
            "file": "lyrics.chordpro",
            "url": None,
            "acquired": None,
            "sha256": sha,
            "licenseBasis": "wc-seed",
            "original": False,
            "submittedBy": None,
            "note": note,
            "layer": "text",
        }
        rows.append(row)
        data["files"] = rows
    row["sha256"] = sha
    row["note"] = note
    mp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def expand_song(d: Path, song: dict, header: str, body: str, abc: Path):
    raw_abc = abc.read_bytes()
    try:
        abc_text = raw_abc.decode("utf-8")
    except UnicodeDecodeError:
        abc_text = raw_abc.decode("latin-1")
    abc_verses = parse_abc_verses(abc_text)
    if len(abc_verses) < 2:
        return None, "abc has no extra verses"
    v1 = stanza_lines(body, "verse 1")
    if not v1:
        return None, "no chordpro verse 1"
    if not texts_match_lines(first_stanza_words(body), abc_verses[0]):
        return None, "abc text does not match verse 1"
    if any(JUNK_VERSE.search(l) for l in v1) or JUNK_VERSE.search(body):
        return None, "template/junk lyrics"
    have = chordpro_verse_nums(body)
    added = []
    for i, abc_lines in enumerate(abc_verses, start=1):
        if i in have:
            continue
        if already_has_text(body, abc_lines):
            continue
        chorded = overlay_verse(v1, abc_lines)
        if not verse_ok(v1, chorded):
            continue
        added.append(f"Verse {i}\n" + "\n".join(chorded))
    if not added:
        return None, "no missing verses"
    new_body = body.rstrip() + "\n\n" + "\n\n".join(added)
    out = (header + "\n\n" if header else "") + new_body
    if not out.endswith("\n"):
        out += "\n"
    return out, f"+{len(added)} ({', '.join('V' + a.split()[1] for a in added)})"


def expand_main():
    stats = {"done": 0, "skip": 0, "no_abc": 0, "blocked": 0, "fail": 0}
    fails = []
    changed = []
    songs = sorted((ROOT / "songs").rglob("lyrics.chordpro"))
    for lyrics in songs:
        if lyrics.parent.name != "sources":
            continue
        d = lyrics.parent.parent
        rel = str(d.relative_to(ROOT)).replace("\\", "/")
        if ONLY and ONLY not in rel and ONLY not in d.name:
            continue
        song = json.loads((d / "song.json").read_text(encoding="utf-8"))
        lic = (song.get("license") or "").lower()
        text_lic = ((song.get("rights") or {}).get("text") or {}).get("license") or lic
        if lic in BLOCK_LIC or (text_lic or "").lower() in BLOCK_LIC:
            stats["blocked"] += 1
            continue
        if lic != "pd" and (text_lic or "").lower() != "pd":
            stats["blocked"] += 1
            continue
        abc = d / "sources" / "tune.abc"
        if not abc.exists():
            stats["no_abc"] += 1
            continue
        raw = lyrics.read_text(encoding="utf-8")
        header, body = split_chordpro(raw)
        abc_text = abc.read_text(encoding="utf-8", errors="replace")
        abc_nums = {int(n) for n in re.findall(r"(?im)^w:\s*(\d+)\.", abc_text)}
        have_nums = chordpro_verse_nums(body)
        if abc_nums and max(abc_nums) <= max(have_nums or [0]):
            stats["skip"] += 1
            continue
        try:
            out, why = expand_song(d, song, header, body, abc)
        except Exception as e:
            stats["fail"] += 1
            fails.append(f"{rel}: {type(e).__name__} {e}")
            continue
        if not out:
            stats["skip"] += 1
            continue
        print(f"  expand {rel} {why}", flush=True)
        changed.append(rel)
        stats["done"] += 1
        if DRY:
            continue
        lyrics.write_text(out, encoding="utf-8", newline="\n")
        _, new_body = split_chordpro(out)
        form = draft_form(new_body, (song.get("form") or {}).get("status") or "draft")
        if form:
            song["form"] = form
            (d / "song.json").write_text(
                json.dumps(song, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
            )
        bump_lyrics_manifest(d, "Expanded remaining verses from the package's Open Hymnal ABC")
    print("expand:", stats, "dry-run" if DRY else "wrote")
    for f in fails[:20]:
        print(" fail:", f)
    if len(fails) > 20:
        print(f" ... and {len(fails) - 20} more")
    if changed:
        print("packages:")
        for rel in changed:
            print(" ", rel)
    return 0 if stats["fail"] < 50 else 1


def main():
    if EXPAND:
        return expand_main()
    stats = {"done": 0, "has_chords": 0, "no_abc": 0, "skip": 0, "fail": 0}
    fails = []
    songs = sorted((ROOT / "songs").rglob("lyrics.chordpro"))
    for lyrics in songs:
        if lyrics.parent.name != "sources":
            continue
        d = lyrics.parent.parent
        rel = str(d.relative_to(ROOT)).replace("\\", "/")
        if ONLY and ONLY not in rel and ONLY not in d.name:
            continue
        song = json.loads((d / "song.json").read_text(encoding="utf-8"))
        raw = lyrics.read_text(encoding="utf-8")
        header, body = split_chordpro(raw)
        if CHORD.search(body):
            stats["has_chords"] += 1
            continue
        abc = find_abc(d, (song.get("parent") or {}).get("id"))
        if not abc:
            stats["no_abc"] += 1
            continue
        try:
            slices, bars, beats, melody = analyze(abc)
            if not melody:
                stats["skip"] += 1
                continue
            key = song.get("key") or ""
            flats = key in FLAT_KEYS or "b" in key
            annotated = annotate(body, build_streams(slices, bars, beats, melody, flats))
        except Exception as e:
            stats["fail"] += 1
            fails.append(f"{rel}: {type(e).__name__} {e}")
            continue
        if not annotated:
            stats["skip"] += 1
            continue
        out = (header + "\n\n" if header else "") + annotated
        if not out.endswith("\n"):
            out += "\n"
        lyrics.write_text(out, encoding="utf-8", newline="\n")
        stats["done"] += 1
        print(f"  chords {rel}", flush=True)
    print("backfill:", stats)
    for f in fails[:20]:
        print(" fail:", f)
    if len(fails) > 20:
        print(f" ... and {len(fails) - 20} more")
    return 0 if stats["fail"] < 50 else 1


if __name__ == "__main__":
    sys.exit(main())
