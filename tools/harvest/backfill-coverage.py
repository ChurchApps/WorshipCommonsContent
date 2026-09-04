# Fill playable coverage from sources we already host.
#   1. Pilato MusicXML <harmony> → ChordPro chords, tune.mid, timing.json
#   2. Foundation / How Firm a Foundation: restore 4-line verses and copy verse-1 chords
#   3. Copy a chorded stanza onto later same-shape stanzas (same label family, same line count)
# Karaoke timings are only written from MusicXML lyrics or from Foundation's known one-verse MIDI.
# Deps: pip install music21 mido
# Usage: python tools/harvest/backfill-coverage.py [--dry-run]
from __future__ import annotations

import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STAGING = ROOT / ".staging" / "cmpilato"
DRY = "--dry-run" in sys.argv
PARTIAL_ONLY = "--partial" in sys.argv

CHORD_RE = re.compile(r"\[([^\]]+)\]")
WORD_RE = re.compile(r"[A-Za-z0-9']+")
NORM_RE = re.compile(r"[^a-z0-9]")


def norm(w: str) -> str:
    return NORM_RE.sub("", w.lower())


def split_chordpro(text: str):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n").split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith("{"):
        i += 1
    if i < len(lines) and lines[i] == "":
        i += 1
    header = "\n".join(lines[:i])
    if header.endswith("\n") is False:
        header = header + "\n" if header else ""
    if i > 0 and lines[i - 1] != "":
        header = header.rstrip("\n") + "\n\n"
    body = "\n".join(lines[i:])
    stanzas, cur = [], []
    for line in body.split("\n"):
        if line.strip() == "":
            if cur:
                stanzas.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        stanzas.append(cur)
    return header, stanzas


def render(header: str, stanzas: list[list[str]]) -> str:
    if header and not header.endswith("\n\n"):
        header = header.rstrip("\n") + "\n\n"
    return header + "\n\n".join("\n".join(st) for st in stanzas) + "\n"


def stanza_chords(st: list[str]) -> list[str]:
    return CHORD_RE.findall("\n".join(st[1:] if len(st) > 1 else st))


def family(label: str) -> str:
    return "chorus" if re.search(r"chorus|refrain", label, re.I) else "verse"


def slug_of(title: str) -> str:
    s = re.sub(r"['’ʼ]", "", title.casefold())
    return re.sub(r"[^\w]+", "-", s, flags=re.UNICODE).strip("-") or "untitled"


def song_dirs():
    songs = ROOT / "songs"
    for lang in sorted(p for p in songs.iterdir() if p.is_dir()):
        for section in sorted(p for p in lang.iterdir() if p.is_dir()):
            for folder in sorted(p for p in section.iterdir() if p.is_dir()):
                yield folder


def load_song(folder: Path) -> dict:
    return json.loads((folder / "song.json").read_text(encoding="utf-8"))


def write_text(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


def save_song(folder: Path, song: dict) -> None:
    write_text(folder / "song.json", json.dumps(song, indent=2, ensure_ascii=False) + "\n")


def clean_figure(fig: str) -> str:
    fig = (fig or "").strip()
    fig = fig.replace(" add ", "add")
    fig = re.sub(r"^([A-G][#b]?(?:/[A-G][#b]?)?)add", lambda m: m.group(1) + "add", fig)
    # "A/C#add4" is fine; "A/C# add 4" already collapsed
    return fig.replace("Maj", "maj").replace("-", "m") if fig else ""


def musicxml_words(xml_path: Path):
    from music21 import converter, harmony, tempo
    score = converter.parse(str(xml_path))
    flat = score.flatten()
    mms = list(flat.getElementsByClass(tempo.MetronomeMark))
    spq = mms[0].secondsPerQuarter() if mms else 0.5

    chords = []
    for cs in flat.getElementsByClass(harmony.ChordSymbol):
        fig = clean_figure(cs.figure)
        if fig:
            chords.append((float(cs.offset), fig))
    chords.sort()

    def chord_at(off: float) -> str | None:
        active = None
        for o, n in chords:
            if o > off + 1e-6:
                break
            active = n
        return active

    # stacked verses (lyric number 2+) sit on the same notes as verse 1 — using
    # every number interleaves syllables. Take the busiest stream (almost always 1).
    by_num: dict[int, int] = {}
    for n in flat.notes:
        for l in n.lyrics or []:
            if l.text and str(l.text).strip():
                by_num[l.number or 1] = by_num.get(l.number or 1, 0) + 1
    keep = max(by_num, key=by_num.get) if by_num else 1

    raw = []
    for n in flat.notes:
        lyrics = [l for l in (n.lyrics or []) if l.text and str(l.text).strip() and (l.number or 1) == keep]
        if not lyrics:
            continue
        off = float(n.offset)
        t = round(off * spq, 3)
        d = round(max(0.12, float(n.quarterLength) * spq), 3)
        ch = chord_at(off)
        for lyr in lyrics:
            text = re.sub(r"^\d+\.\s*", "", str(lyr.text).replace("\xa0", " ")).strip()
            if not text:
                continue
            syll = getattr(lyr, "syllabic", None)
            syll = (getattr(syll, "name", None) or str(syll or "single")).lower()
            raw.append({"t": t, "d": d, "text": text, "chord": ch, "syllabic": syll, "off": off})
    for i, e in enumerate(raw):
        if i + 1 < len(raw):
            gap = raw[i + 1]["t"] - e["t"]
            if gap > 0:
                e["d"] = round(max(0.12, gap), 3)

    words, openw = [], None
    for e in raw:
        syl = e["syllabic"]
        if openw is not None and syl in ("middle", "end"):
            openw["text"] += e["text"]
            openw["d"] = round(e["t"] + e["d"] - openw["t"], 3)
            if e["chord"] and not openw["chord"]:
                openw["chord"] = e["chord"]
            if syl == "end":
                words.append(openw)
                openw = None
            continue
        if openw is not None:
            words.append(openw)
            openw = None
        item = {"t": e["t"], "d": e["d"], "text": e["text"], "chord": e["chord"]}
        if syl == "begin":
            openw = item
        else:
            words.append(item)
    if openw is not None:
        words.append(openw)
    for w in words:
        w["text"] = re.sub(r"^\d+\.\s*", "", w["text"]).strip()
    words = [w for w in words if w["text"]]
    dur = round(float(flat.highestTime) * spq, 3)
    return score, words, dur


def inject_line(line: str, chunk: list[dict]) -> str:
    matches = list(WORD_RE.finditer(line))
    if not matches or not chunk:
        return line
    out, last, ci, last_chord = [], 0, 0, None
    for m in matches:
        out.append(line[last:m.start()])
        nw = norm(m.group())
        while ci < len(chunk) and norm(chunk[ci]["text"]) != nw:
            # skip a hyphenated leftover if the next xml word matches
            if ci + 1 < len(chunk) and norm(chunk[ci + 1]["text"]) == nw:
                ci += 1
                break
            break
        chord = None
        if ci < len(chunk) and norm(chunk[ci]["text"]) == nw:
            chord = chunk[ci]["chord"]
            ci += 1
        if chord and chord != last_chord:
            out.append(f"[{chord}]")
            last_chord = chord
        out.append(m.group())
        last = m.end()
    out.append(line[last:])
    return "".join(out)


def apply_xml(stanzas, words):
    i, last_chord = 0, None
    out = []
    for st in stanzas:
        label, lines = st[0], st[1:]
        new_lines = []
        for line in lines:
            lyric_words = WORD_RE.findall(line)
            chunk = []
            for lw in lyric_words:
                target = norm(lw)
                found = None
                for k in range(i, min(i + 5, len(words))):
                    if norm(words[k]["text"]) == target:
                        found = k
                        break
                if found is None:
                    chunk.append({"text": lw, "chord": None})
                    continue
                i = found
                w = dict(words[i])
                if w["chord"] == last_chord:
                    w["chord"] = None
                elif w["chord"]:
                    last_chord = w["chord"]
                chunk.append(w)
                i += 1
            new_lines.append(inject_line(line, chunk) if chunk else line)
        out.append([label] + new_lines)
    return out, i


def timing_from_words(stanzas, words, dur):
    i = 0
    st_out = []
    for st in stanzas:
        tlines = []
        for line in st[1:]:
            tl = []
            for lw in WORD_RE.findall(line):
                target = norm(lw)
                found = None
                for k in range(i, min(i + 5, len(words))):
                    if norm(words[k]["text"]) == target:
                        found = k
                        break
                if found is None:
                    continue
                i = found
                w = words[i]
                tl.append({"t": w["t"], "d": w["d"], "text": lw})
                i += 1
            if tl:
                tlines.append(tl)
        if tlines:
            st_out.append({"label": st[0], "lines": tlines})
    return {"duration": dur, "stanzas": st_out}


def line_tokens(line: str) -> list[tuple[str | None, str]]:
    out, pending = [], None
    for tok in re.findall(r"\[[^\]]+\]|\S+", line):
        if tok.startswith("["):
            pending = tok[1:-1]
        else:
            out.append((pending, tok))
            pending = None
    return out


def reflow(tokens: list[str], counts: list[int]) -> list[list[str]]:
    n = len(tokens)
    if not counts:
        return [tokens]
    total = sum(counts) or 1
    sizes = [max(1, round(n * c / total)) for c in counts]
    while sum(sizes) > n and max(sizes) > 1:
        sizes[sizes.index(max(sizes))] -= 1
    i = 0
    while sum(sizes) < n:
        sizes[i % len(sizes)] += 1
        i += 1
    groups, k = [], 0
    for s in sizes:
        groups.append(tokens[k:k + s])
        k += s
    return groups


def apply_donor(donor: list[str], target: list[str]) -> list[str] | None:
    donor_lines = [line_tokens(line) for line in donor[1:]]
    target_tok = [tok for line in target[1:] for _, tok in line_tokens(CHORD_RE.sub("", line))]
    donor_n = sum(len(line) for line in donor_lines)
    if donor_n == 0 or len(target_tok) < max(4, int(0.45 * donor_n)):
        return None
    groups = reflow(target_tok, [len(line) for line in donor_lines])
    new_lines = []
    for dline, group in zip(donor_lines, groups):
        if not group:
            continue
        src_chords = [(i, c) for i, (c, _) in enumerate(dline) if c]
        nd, ng = max(len(dline), 1), len(group)
        mapped = {}
        for i, c in src_chords:
            mapped[min(ng - 1, round(i * ng / nd))] = c
        new_lines.append(" ".join((f"[{mapped[i]}]" if mapped.get(i) else "") + tok for i, tok in enumerate(group)))
    if not new_lines or not stanza_chords([target[0]] + new_lines):
        return None
    return [target[0]] + new_lines


def copy_chords_across_verses(stanzas):
    donors = {}
    for st in stanzas:
        if len(st) < 2 or not stanza_chords(st):
            continue
        donors.setdefault(family(st[0]), st)
    if not donors:
        return stanzas, 0
    changed, out = 0, []
    for st in stanzas:
        donor = donors.get(family(st[0]))
        if stanza_chords(st) or donor is None or len(st) < 2:
            out.append(st)
            continue
        new_st = apply_donor(donor, st)
        if new_st:
            changed += 1
            out.append(new_st)
        else:
            out.append(st)
    return out, changed


FOUNDATION_VERSES = {
    "Verse 2": [
        "In every condition, in sickness, in health;",
        "in poverty's vale, or abounding in wealth;",
        "at home and abroad, on the land, on the sea,",
        "as thy days demand, shall thy strength ever be.",
    ],
    "Verse 3": [
        "Fear not, I am with thee, O be not dismayed,",
        "for I am thy God, and will still give thee aid;",
        "I'll strengthen and help thee, and cause thee to stand,",
        "upheld by my righteous, omnipotent hand.",
    ],
    "Verse 4": [
        "When through the deep waters I call thee to go,",
        "the rivers of woe shall not thee overflow;",
        "for I will be with thee, thy troubles to bless,",
        "and sanctify to thee thy deepest distress.",
    ],
    "Verse 5": [
        "When through fiery trials thy pathways shall lie,",
        "my grace, all sufficient, shall be thy supply;",
        "the flame shall not hurt thee; I only design",
        "thy dross to consume, and thy gold to refine.",
    ],
}


def fix_reline(folder: Path, verses: dict[str, list[str]]):
    cp_path = folder / "lyrics.chordpro"
    header, stanzas = split_chordpro(cp_path.read_text(encoding="utf-8"))
    new = []
    for st in stanzas:
        if st[0] in verses:
            new.append([st[0]] + verses[st[0]])
        else:
            new.append(st)
    new, n = copy_chords_across_verses(new)
    if DRY:
        print(f"  reline {folder.name}: {n} stanzas chorded")
        return n
    write_text(cp_path, render(header, new))
    print(f"  reline {folder.name}: {n} stanzas chorded")
    return n


def tile_midi(src_path: Path, copies: int, dest: Path):
    import mido
    src = mido.MidiFile(str(src_path))
    out = mido.MidiFile(ticks_per_beat=src.ticks_per_beat)
    pad = src.ticks_per_beat  # one beat between verses
    for tr in src.tracks:
        body = [m for m in tr if m.type != "end_of_track"]
        tick_len = sum(m.time for m in body)
        new = mido.MidiTrack()
        for c in range(copies):
            for j, m in enumerate(body):
                nm = m.copy()
                if c > 0 and j == 0:
                    nm.time += pad
                new.append(nm)
        new.append(mido.MetaMessage("end_of_track", time=0))
        out.tracks.append(new)
    out.save(str(dest))
    return out.length


def foundation_karaoke(folder: Path):
    import mido
    mid_path = folder / "tune.mid"
    if not mid_path.exists():
        return False
    header, stanzas = split_chordpro((folder / "lyrics.chordpro").read_text(encoding="utf-8"))
    mid = mido.MidiFile(str(mid_path))
    # MidiFile iteration already yields delta times in seconds
    onsets, t = [], 0.0
    for msg in mid:
        t += msg.time
        if msg.type == "note_on" and getattr(msg, "velocity", 0) > 0:
            if not onsets or t - onsets[-1] > 0.05:
                onsets.append(round(t, 3))
    if len(onsets) < 8:
        return False
    def words_of(st):
        return [WORD_RE.findall(CHORD_RE.sub("", line)) for line in st[1:] if WORD_RE.findall(CHORD_RE.sub("", line))]
    grid = [w for line in words_of(stanzas[0]) for w in line]
    n_slots = max(len(grid), 1)
    slot_t = [onsets[min(len(onsets) - 1, round(i * (len(onsets) - 1) / max(n_slots - 1, 1)))] for i in range(n_slots)]
    # one-beat rest between tiled verses (tile_midi pad = ticks_per_beat)
    orig_play = 0.0
    for msg in mido.MidiFile(str(mid_path)):
        orig_play += msg.time
    cycle = orig_play + 60.0 / 160.0  # LilyPond tempo 4=160; pad is one quarter
    st_out = []
    for si, st in enumerate(stanzas):
        lines = words_of(st)
        flat_w = [w for line in lines for w in line]
        n = max(len(flat_w), 1)
        tlines, k = [], 0
        base = round(si * cycle, 3)
        for line in lines:
            tl = []
            for w in line:
                src_i = min(len(slot_t) - 1, round(k * (len(slot_t) - 1) / max(n - 1, 1)))
                t0 = slot_t[src_i]
                t1 = slot_t[src_i + 1] if src_i + 1 < len(slot_t) else onsets[-1] + 0.3
                tl.append({"t": round(base + t0 - slot_t[0], 3), "d": round(max(0.12, t1 - t0), 3), "text": w})
                k += 1
            tlines.append(tl)
        st_out.append({"label": st[0], "lines": tlines})
    dur = round((len(stanzas) - 1) * cycle + orig_play, 3)
    if DRY:
        print(f"  karaoke {folder.name}: {len(stanzas)} stanzas, {dur}s")
        return True
    tile_midi(mid_path, len(stanzas), mid_path)
    write_text(folder / "timing.json", json.dumps({"duration": dur, "stanzas": st_out}, ensure_ascii=False) + "\n")
    song = load_song(folder)
    song.setdefault("provenance", {})
    song["provenance"]["timing"] = "worshipcommons"
    save_song(folder, song)
    print(f"  karaoke {folder.name}: {len(stanzas)} stanzas, {dur}s")
    return True


def process_musicxml(folder: Path, xml_path: Path):
    score, words, dur = musicxml_words(xml_path)
    cp_path = folder / "lyrics.chordpro"
    header, stanzas = split_chordpro(cp_path.read_text(encoding="utf-8"))
    before = sum(len(stanza_chords(st)) for st in stanzas)
    new_stanzas, used = apply_xml(stanzas, words)
    after = sum(len(stanza_chords(st)) for st in new_stanzas)
    timing = timing_from_words(stanzas, words, dur)
    if DRY:
        print(f"  XML {folder.name}: chords {before}→{after}, xml-words {len(words)} used {used}, dur {dur}s")
        return
    if after > before:
        write_text(cp_path, render(header, new_stanzas))
    score.write("midi", fp=str(folder / "tune.mid"))
    write_text(folder / "timing.json", json.dumps(timing, ensure_ascii=False) + "\n")
    song = load_song(folder)
    song.setdefault("provenance", {})
    song["provenance"]["tune"] = "cmpilato"
    song["provenance"]["timing"] = "worshipcommons"
    save_song(folder, song)
    print(f"  XML {folder.name}: chords {before}→{after}, midi+timing ({dur}s)")


def main():
    if PARTIAL_ONLY:
        copied = 0
        for folder in song_dirs():
            cp_path = folder / "lyrics.chordpro"
            if not cp_path.exists():
                continue
            header, stanzas = split_chordpro(cp_path.read_text(encoding="utf-8"))
            if not any(stanza_chords(st) for st in stanzas):
                continue
            new, n = copy_chords_across_verses(stanzas)
            if n == 0:
                continue
            if DRY:
                print(f"  copy-chords {folder.parent.name}/{folder.name}: {n}")
            else:
                write_text(cp_path, render(header, new))
                print(f"  copy-chords {folder.parent.name}/{folder.name}: {n}")
            copied += 1
        print(f"done. chord-copy songs {copied}{' (dry-run)' if DRY else ''}")
        return

    xml_by_slug = {}
    if STAGING.exists():
        for d in STAGING.iterdir():
            if not d.is_dir():
                continue
            xml = next(d.glob("*.musicxml"), None)
            if xml:
                xml_by_slug[slug_of(d.name.replace("_", " "))] = xml

    n_xml = 0
    for folder in song_dirs():
        song = load_song(folder)
        if song.get("provenance", {}).get("text") != "cmpilato":
            continue
        xml = xml_by_slug.get(folder.name)
        if not xml:
            continue
        process_musicxml(folder, xml)
        n_xml += 1

    n_reline = 0
    for rel in [
        ROOT / "songs/en/cc-by-sa/foundation",
        ROOT / "songs/en/public-domain/how-firm-a-foundation",
    ]:
        if rel.exists():
            n_reline += fix_reline(rel, FOUNDATION_VERSES)

    if (ROOT / "songs/en/cc-by-sa/foundation").exists():
        foundation_karaoke(ROOT / "songs/en/cc-by-sa/foundation")

    copied = 0
    for folder in song_dirs():
        cp_path = folder / "lyrics.chordpro"
        if not cp_path.exists():
            continue
        header, stanzas = split_chordpro(cp_path.read_text(encoding="utf-8"))
        if not any(stanza_chords(st) for st in stanzas):
            continue
        if all(stanza_chords(st) or len(st) < 2 for st in stanzas):
            continue
        new, n = copy_chords_across_verses(stanzas)
        if n == 0:
            continue
        if DRY:
            print(f"  copy-chords {folder.parent.name}/{folder.name}: {n}")
        else:
            write_text(cp_path, render(header, new))
            print(f"  copy-chords {folder.parent.name}/{folder.name}: {n}")
        copied += 1

    print(f"done. musicxml {n_xml}, reline {n_reline}, chord-copy songs {copied}{' (dry-run)' if DRY else ''}")


if __name__ == "__main__":
    main()
