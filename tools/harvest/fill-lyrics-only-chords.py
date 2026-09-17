"""Fill chords on lyrics-only songs from legal sources we already trust.

Phases:
  1. Inherit chord symbols from a charted parent (or TCH-slug English original).
  2. Attach a matching Open Hymnal PD ABC and backfill from SATB.
  3. Fetch Cyber Hymnal MusicXML via Hymnary (PD + TCH attribution) for leftover
     English PD titles, chordify, and inject.

Does not scrape SongSelect/UG, HymnSite sequences, or modern arrangements.
CMAA PDFs are SATB engravings without a text chord layer — skipped here.

  python tools/harvest/fill-lyrics-only-chords.py [--dry-run] [--skip-hymnary]
"""
from __future__ import annotations

import hashlib, json, os, re, sys, time, unicodedata, urllib.parse, urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRY = "--dry-run" in sys.argv
SKIP_HYMNARY = "--skip-hymnary" in sys.argv
HYMNARY_ONLY = "--hymnary-only" in sys.argv
UA = "WorshipCommons content harvest (jeremy@zongker.net)"
OH_ABC = "http://openhymnal.org/Abc/"
HYMNARY = "https://hymnary.org"
CHORD = re.compile(r"\[[A-G][#b]?")
CHORD_TOKEN = re.compile(r"\[([^\]]+)\]")
SECTION = re.compile(
    r"^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus|"
    r"estrofa|coro|estribillo|strophe|kehrvers)\b",
    re.I,
)
PD_RE = re.compile(
    r"^(public domain|words, public domain\.\s*adaptation released into public domain|"
    r"music and setting public domain\.$)",
    re.I,
)
# Living / house-licensed rows must not absorb an OH/TCH SATB of a different work.
BLOCK_LIC = {"larry-holder"}
FALSE_OH = {
    "it is well demons shall flee",  # Holder original, not Ville du Havre
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("ß", "ss")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def split_chordpro(text: str):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n").split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith("{"):
        i += 1
    if i < len(lines) and lines[i] == "":
        i += 1
    header = "\n".join(lines[:i]).rstrip("\n")
    body = "\n".join(lines[i:])
    stanzas, cur = [], []
    for line in body.split("\n"):
        if not line.strip():
            if cur:
                stanzas.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        stanzas.append(cur)
    return header, stanzas


def render(header: str, stanzas: list[list[str]]) -> str:
    h = header.rstrip("\n")
    if h:
        h += "\n\n"
    return h + "\n\n".join("\n".join(st) for st in stanzas) + "\n"


def is_label(line: str) -> bool:
    plain = CHORD_TOKEN.sub("", line).strip()
    return bool(plain) and SECTION.match(plain) and not CHORD_TOKEN.search(line)


def lyric_lines(st: list[str]) -> list[str]:
    lines = st[1:] if st and is_label(st[0]) else st
    return [ln for ln in lines if not ln.strip().startswith("{")]


def label_key(st: list[str]) -> str:
    if not st or not is_label(st[0]):
        return ""
    s = CHORD_TOKEN.sub("", st[0]).strip().lower()
    if re.search(r"chorus|refrain|coro|estribillo|kehrvers", s):
        return "chorus"
    m = re.search(r"(\d+)", s)
    if m:
        return f"v{m.group(1)}"
    return "verse"


def line_pairs(line: str) -> list[tuple[str | None, str]]:
    out, pending = [], None
    for tok in re.findall(r"\[[^\]]+\]|\S+", line):
        if tok.startswith("["):
            pending = tok[1:-1]
        else:
            out.append((pending, tok))
            pending = None
    return out


def flatten(st: list[str]) -> list[tuple[str | None, str]]:
    out = []
    for ln in lyric_lines(st):
        out.extend(line_pairs(ln))
    return out


def place_chords(parent_words: list[tuple[str | None, str]], child_st: list[str]) -> list[str] | None:
    pw = parent_words
    child_lyric = lyric_lines(child_st)
    if not pw or not child_lyric:
        return None
    child_rows = [re.findall(r"\S+", CHORD_TOKEN.sub("", ln)) for ln in child_lyric]
    n_c = sum(len(r) for r in child_rows)
    n_p = len(pw)
    if not n_c:
        return None
    ratio = n_c / n_p
    if not (0.4 <= ratio <= 2.5):
        return None
    at = {}
    last = None
    for i, (ch, _) in enumerate(pw):
        if not ch or ch == last:
            continue
        j = min(n_c - 1, round(i * n_c / n_p))
        if j not in at:
            at[j] = ch
            last = ch
    if not at:
        return None
    out_lyrics, idx = [], 0
    for words, raw in zip(child_rows, child_lyric):
        if not words:
            out_lyrics.append(raw)
            continue
        # rebuild from original spacing by walking words
        pieces, cursor = [], 0
        plain = CHORD_TOKEN.sub("", raw)
        for w in words:
            pos = plain.find(w, cursor)
            if pos < 0:
                pos = cursor
            pieces.append(plain[cursor:pos])
            if idx in at:
                pieces.append(f"[{at[idx]}]")
            pieces.append(w)
            cursor = pos + len(w)
            idx += 1
        pieces.append(plain[cursor:])
        out_lyrics.append("".join(pieces))
    if is_label(child_st[0]):
        return [child_st[0]] + out_lyrics
    return out_lyrics


def inherit_stanzas(parent_st, child_st) -> list[list[str]] | None:
    pmap = {}
    for i, st in enumerate(parent_st):
        k = label_key(st) or f"i{i}"
        pmap.setdefault(k, st)
    used = 0
    out = []
    for i, st in enumerate(child_st):
        k = label_key(st) or f"i{i}"
        src = pmap.get(k) or (parent_st[i] if i < len(parent_st) else pmap.get("v1") or parent_st[0])
        placed = place_chords(flatten(src), st)
        if placed is None:
            out.append(st)
        else:
            out.append(placed)
            used += 1
    if not used:
        return None
    return out


def write_lyrics(pkg: Path, header: str, stanzas: list[list[str]], note: str):
    path = pkg / "sources" / "lyrics.chordpro"
    text = render(header, stanzas)
    if DRY:
        print(f"  DRY {pkg.relative_to(ROOT)} ({note})")
        return
    path.write_text(text, encoding="utf-8", newline="\n")
    bump_manifest(pkg, "lyrics.chordpro", note=note)
    print(f"  wrote {pkg.relative_to(ROOT)} ({note})")


def bump_manifest(pkg: Path, filename: str, *, url=None, basis=None, note=None, layer=None, acquired=None):
    mp = pkg / "sources" / "manifest.json"
    data = json.loads(mp.read_text(encoding="utf-8")) if mp.exists() else {"files": []}
    rows = data.get("files") or []
    p = pkg / "sources" / filename
    sha = sha256(p) if p.exists() else None
    row = next((r for r in rows if r.get("file") == filename), None)
    if row is None:
        row = {"file": filename, "url": None, "acquired": None, "sha256": sha,
               "licenseBasis": basis or "contributor", "original": False,
               "submittedBy": None, "note": note}
        rows.append(row)
    row["sha256"] = sha
    if url:
        row["url"] = url
        row["acquired"] = acquired or time.strftime("%Y-%m-%d")
        row["original"] = True
    if basis:
        row["licenseBasis"] = basis
    if note:
        row["note"] = note
    if layer:
        row["layer"] = layer
        row["obtainedVia"] = "harvest"
    data["files"] = rows
    mp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def pkg_of_row(root: Path, r: dict) -> Path | None:
    u = r.get("midiUrl") or r.get("compositionZipUrl") or r.get("artUrl") or r.get("lyricsUrl")
    if not u:
        return None
    return root / "/".join(u.replace("\\", "/").split("/")[:3])


def load_catalog(root: Path):
    return json.loads((root / "catalog.json").read_text(encoding="utf-8"))["rows"]


def http_get(url: str, delay=1.0) -> bytes | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            if getattr(resp, "status", 200) >= 400:
                return None
            data = resp.read()
    except Exception:
        return None
    finally:
        time.sleep(delay)
    return data


def slug_from_title(title: str) -> str:
    s = norm(re.sub(r"\([^)]*\)", "", title))
    return s.replace(" ", "_")


def phase_inherit(root: Path, rows: list[dict]) -> int:
    by_id = {r["id"]: r for r in rows}
    charted = [r for r in rows if CHORD.search(r.get("chordPro") or "")]
    by_title = defaultdict(list)
    for r in charted:
        by_title[norm(r["title"])].append(r)

    url_re = re.compile(r"/([^/]+?)(?:_ml|_es|_spa|_de|_fr|_pt|_ru|_hu|_sq)?\.htm", re.I)
    n = 0
    lo = [r for r in rows if r.get("confidence") == "lyrics-only"]
    for r in lo:
        pkg = pkg_of_row(root, r)
        if not pkg or not (pkg / "sources" / "lyrics.chordpro").exists():
            continue
        raw = (pkg / "sources" / "lyrics.chordpro").read_text(encoding="utf-8")
        header, child_st = split_chordpro(raw)
        if CHORD.search(raw):
            continue
        src = None
        parent = by_id.get(r.get("parentSongId") or "")
        if parent and CHORD.search(parent.get("chordPro") or ""):
            src = parent
        if src is None:
            sj = json.loads((pkg / "song.json").read_text(encoding="utf-8"))
            url = ((sj.get("rights") or {}).get("text") or {}).get("url") or ""
            m = url_re.search(url.replace("\\", "/"))
            if m:
                q = norm(m.group(1).replace("_", " "))
                q = re.sub(r"\bml\b$", "", q).strip()
                hits = by_title.get(q) or []
                if not hits:
                    w = q.split()
                    for k in range(min(6, len(w)), 2, -1):
                        cand = by_title.get(" ".join(w[:k]))
                        if cand and len(cand) == 1:
                            hits = cand
                            break
                if hits:
                    src = hits[0]
        if not src:
            continue
        # catalog chordPro is the body (no {title} header)
        parent_st = split_chordpro(src.get("chordPro") or "")[1]
        if not parent_st:
            continue
        placed = inherit_stanzas(parent_st, child_st)
        if not placed:
            continue
        write_lyrics(pkg, header, placed, f"inherited from {src['id']} {src['title']}")
        n += 1
    return n


def oh_index():
    html = http_get(OH_ABC, delay=1.0)
    if not html:
        return []
    return re.findall(r'href="([^"]+\.abc)"', html.decode("utf-8", "replace"), re.I)


def file_keys(name: str) -> set[str]:
    stem = name[:-4] if name.lower().endswith(".abc") else name
    keys = set()
    for bit in stem.split("-"):
        k = norm(bit.replace("_", " "))
        if k:
            keys.add(k)
    keys.add(norm(stem.split("-")[0].replace("_", " ")))
    return keys


def first_line(stanzas) -> str:
    for st in stanzas:
        for ln in lyric_lines(st):
            t = CHORD_TOKEN.sub("", ln).strip()
            if t:
                return norm(t)
    return ""


def phase_openhymnal(root: Path, rows: list[dict]) -> int:
    files = oh_index()
    print(f"OH ABC files listed: {len(files)}")
    key_map = defaultdict(list)
    for f in files:
        for k in file_keys(f):
            key_map[k].append(f)

    lo = [r for r in rows if r.get("confidence") == "lyrics-only"]
    # re-read disk: inherit may have filled some
    n = 0
    for r in lo:
        if r.get("license") in BLOCK_LIC:
            continue
        if r.get("license") != "PD":
            continue
        nt = norm(re.sub(r"\([^)]*\)", "", r["title"]))
        if nt in FALSE_OH:
            continue
        pkg = pkg_of_row(root, r)
        if not pkg:
            continue
        lyrics = pkg / "sources" / "lyrics.chordpro"
        if not lyrics.exists() or CHORD.search(lyrics.read_text(encoding="utf-8")):
            continue
        if (pkg / "sources" / "tune.abc").exists():
            continue
        names = key_map.get(nt) or []
        if not names:
            w = nt.split()
            if len(w) >= 4:
                names = key_map.get(" ".join(w[:4])) or []
            if not names and len(w) >= 3:
                names = key_map.get(" ".join(w[:3])) or []
        if not names:
            continue
        fname = names[0]
        abc = http_get(OH_ABC + fname, delay=1.0)
        if not abc:
            print(f"  miss download {fname}")
            continue
        text = abc.decode("utf-8", "replace")
        if "\ufffd" in text[:200]:
            text = abc.decode("latin-1")
        cr = re.search(r"^C:\s*copyright:\s*(.+)$", text, re.I | re.M)
        copyright = cr.group(1).strip() if cr else ""
        if not PD_RE.search(copyright):
            print(f"  skip not-PD {fname} C:{copyright[:80]}")
            continue
        if re.search(r"freely reproduced or published for christian worship|all other rights reserved", text, re.I):
            print(f"  skip worship-only {fname}")
            continue
        dest = pkg / "sources" / "tune.abc"
        if DRY:
            print(f"  DRY ABC {pkg.relative_to(ROOT)} <- {fname}")
            n += 1
            continue
        dest.write_text(text, encoding="utf-8", newline="\n")
        bump_manifest(
            pkg, "tune.abc",
            url=OH_ABC + fname,
            basis="open-hymnal",
            note="Open Hymnal ABC; C: public domain verified at attach",
            layer="tune",
        )
        sj = json.loads((pkg / "song.json").read_text(encoding="utf-8"))
        rights = sj.setdefault("rights", {})
        tune = rights.get("tune")
        if not isinstance(tune, dict):
            rights["tune"] = {"license": "PD", "basis": "open-hymnal", "source": "open-hymnal"}
            (pkg / "song.json").write_text(json.dumps(sj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        elif not tune.get("license"):
            tune["license"] = "PD"
            tune["basis"] = tune.get("basis") or "open-hymnal"
            tune["source"] = tune.get("source") or "open-hymnal"
            (pkg / "song.json").write_text(json.dumps(sj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"  abc {pkg.relative_to(ROOT)} <- {fname}")
        n += 1
    return n


def hymnary_text_url(title: str) -> str:
    slug = slug_from_title(title)
    # hymnary slugs drop most punctuation already via norm
    return f"{HYMNARY}/text/{slug}"


def cyber_xml_id(html: str) -> str | None:
    m = re.search(
        r"The Cyber Hymnal[^<]*</h6>\s*<ul>[\s\S]{0,800}?<a href=\"(/media/fetch/\d+)\">XML</a>",
        html, re.I,
    )
    if m:
        return m.group(1)
    m = re.search(r'<a href="(/media/fetch/\d+)">XML</a>', html, re.I)
    return m.group(1) if m else None


def is_pd_page(html: str) -> bool:
    return bool(re.search(
        r'hy_infoLabel">Copyright:</span></td>\s*<td><span class="hy_infoItem">Public Domain</span>',
        html, re.I,
    ))


def chordify_xml(xml_path: Path) -> list[str]:
    """Beat-level chord names from SATB MusicXML. Empty if nothing harmonic."""
    from music21 import converter, stream, meter as m21meter
    score = converter.parse(str(xml_path))
    names = []
    last = None
    for c in score.chordify().flatten().notes:
        pitches = list(c.pitches) if hasattr(c, "pitches") else []
        if len(pitches) < 2:
            continue
        pcs = {p.pitchClass for p in pitches}
        bass = min(p.midi for p in pitches) % 12
        # reuse simple triad naming
        SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        best = None
        for root in sorted(pcs):
            rel = frozenset((p - root) % 12 for p in pcs)
            for ivs, suf in (((0, 4, 7), ""), ((0, 3, 7), "m"), ((0, 4, 7, 10), "7"), ((0, 3, 7, 10), "m7")):
                if 0 in rel and not (rel - set(ivs)):
                    score_t = (len(rel & set(ivs)), root == bass, -len(ivs))
                    if best is None or score_t > best[0]:
                        best = (score_t, SHARP[root] + suf)
        if best and best[1] != last:
            names.append(best[1])
            last = best[1]
    return names


def inject_sequence(stanzas: list[list[str]], chords: list[str]) -> list[list[str]] | None:
    if not chords:
        return None
    # count lyric words
    total = 0
    rows = []
    for st in stanzas:
        ll = lyric_lines(st)
        words = [re.findall(r"\S+", CHORD_TOKEN.sub("", ln)) for ln in ll]
        total += sum(len(w) for w in words)
        rows.append((st, ll, words))
    if total < 4:
        return None
    # spread chord changes evenly across words
    at = {}
    for i, ch in enumerate(chords):
        j = min(total - 1, round(i * total / max(len(chords), 1)))
        at[j] = ch
    idx = 0
    out = []
    for st, ll, words in rows:
        new_ll = []
        for raw, ww in zip(ll, words):
            if not ww:
                new_ll.append(raw)
                continue
            pieces, cursor = [], 0
            plain = CHORD_TOKEN.sub("", raw)
            for w in ww:
                pos = plain.find(w, cursor)
                if pos < 0:
                    pos = cursor
                pieces.append(plain[cursor:pos])
                if idx in at:
                    pieces.append(f"[{at[idx]}]")
                pieces.append(w)
                cursor = pos + len(w)
                idx += 1
            pieces.append(plain[cursor:])
            new_ll.append("".join(pieces))
        out.append([st[0]] + new_ll if st and is_label(st[0]) else new_ll)
    return out


def abc_to_xml(abc: Path) -> Path | None:
    import subprocess, tempfile
    abc2xml = ROOT / "tools" / "vendor" / "abc2xml.py"
    td = Path(tempfile.mkdtemp(prefix="abc2xml-"))
    r = subprocess.run([sys.executable, str(abc2xml), "-o", str(td), str(abc)], capture_output=True, text=True)
    xml = next(td.glob("*.xml"), None)
    return xml if r.returncode == 0 and xml else None


def phase_abc_inject(root: Path) -> int:
    n = 0
    for lyrics in root.glob("songs/*/*/sources/lyrics.chordpro"):
        pkg = lyrics.parents[1]
        abc = pkg / "sources" / "tune.abc"
        if not abc.exists():
            continue
        raw = lyrics.read_text(encoding="utf-8")
        if CHORD.search(raw):
            continue
        xml = abc_to_xml(abc)
        if not xml:
            print(f"  abc2xml fail {pkg.relative_to(root)}")
            continue
        try:
            seq = chordify_xml(xml)
        except Exception as e:
            print(f"  abc chordify fail {pkg.relative_to(root)}: {e}")
            continue
        header, stanzas = split_chordpro(raw)
        placed = inject_sequence(stanzas, seq)
        if not placed:
            print(f"  abc inject skip {pkg.relative_to(root)} seq={len(seq)}")
            continue
        write_lyrics(pkg, header, stanzas if False else placed, f"OH ABC SATB ({len(seq)} chords)")
        n += 1
    return n


def phase_hymnary(root: Path, rows: list[dict]) -> int:
    lo = [r for r in rows if r.get("confidence") == "lyrics-only"
          and r.get("license") == "PD" and r.get("language") == "English"]
    n = 0
    for r in lo:
        pkg = pkg_of_row(root, r)
        if not pkg:
            continue
        lyrics = pkg / "sources" / "lyrics.chordpro"
        if not lyrics.exists() or CHORD.search(lyrics.read_text(encoding="utf-8")):
            continue
        url = hymnary_text_url(r["title"])
        html_b = http_get(url, delay=5.0)
        if not html_b:
            q = re.sub(r"\([^)]*\)", "", r["title"]).strip()
            csv_b = http_get(f"{HYMNARY}/search?qu={urllib.parse.quote(q)}&export=csv", delay=5.0)
            slug = None
            if csv_b:
                for line in csv_b.decode("utf-8", "replace").splitlines()[1:6]:
                    cols = line.split(",")
                    # slug is column 5 (0-based 4) per import-hymnary-popularity.ts
                    if len(cols) >= 5 and cols[4] and cols[4] != "readings":
                        slug = cols[4].strip().strip('"')
                        break
            if not slug:
                print(f"  hymnary 404 {r['title']}")
                continue
            html_b = http_get(f"{HYMNARY}/text/{slug}", delay=5.0)
            if not html_b:
                print(f"  hymnary 404 slug {slug} {r['title']}")
                continue
            url = f"{HYMNARY}/text/{slug}"
        html = html_b.decode("utf-8", "replace")
        if not is_pd_page(html):
            print(f"  hymnary not PD {r['title']}")
            continue
        xml_href = cyber_xml_id(html)
        if not xml_href:
            print(f"  hymnary no TCH XML {r['title']}")
            continue
        xml_b = http_get(HYMNARY + xml_href, delay=5.0)
        if not xml_b or len(xml_b) < 200:
            print(f"  hymnary xml fail {r['title']}")
            continue
        dest = pkg / "sources" / "score.musicxml"
        if DRY:
            print(f"  DRY xml {pkg.relative_to(ROOT)} <- {xml_href}")
            n += 1
            continue
        dest.write_bytes(xml_b)
        bump_manifest(
            pkg, "score.musicxml",
            url=HYMNARY + xml_href,
            basis="cyber-hymnal",
            note="Cyber Hymnal MusicXML via Hymnary; PD page + TCH XML link",
            layer="tune",
        )
        try:
            seq = chordify_xml(dest)
        except Exception as e:
            print(f"  chordify fail {r['title']}: {e}")
            n += 1
            continue
        header, stanzas = split_chordpro(lyrics.read_text(encoding="utf-8"))
        placed = inject_sequence(stanzas, seq)
        if placed:
            write_lyrics(pkg, header, placed, f"TCH XML via Hymnary ({len(seq)} chords)")
        else:
            print(f"  xml saved, no chord inject {r['title']} seq={len(seq)}")
        n += 1
    return n


def main():
    rows = load_catalog(ROOT)
    print("catalog", len(rows), "lyrics-only", sum(1 for r in rows if r.get("confidence") == "lyrics-only"))
    if HYMNARY_ONLY:
        c = phase_hymnary(ROOT, rows)
        print("hymnary xml:", c)
        return 0
    a = phase_inherit(ROOT, rows)
    print("inherit:", a)
    b = phase_openhymnal(ROOT, rows)
    print("openhymnal attach:", b)
    # backfill from newly attached ABC
    if b and not DRY:
        import subprocess
        r = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "harvest" / "backfill-library-chords.py")],
            cwd=ROOT,
        )
        print("backfill-library-chords exit", r.returncode)
    abc_n = phase_abc_inject(ROOT)
    print("abc satb inject:", abc_n)
    c = 0
    if not SKIP_HYMNARY:
        c = phase_hymnary(ROOT, rows)
        print("hymnary xml:", c)
    print("filled this run (inherit/oh/abc-inject/hymnary):", a, b, abc_n, c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
