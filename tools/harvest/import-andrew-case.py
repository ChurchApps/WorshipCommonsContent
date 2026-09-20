"""Harvest Andrew Case originals from hismagnificence.com/music/.

Skip Sing Hebrew (user), third-party compositions, ESV-labeled psalm sheets,
traditional hymns already in the catalog, instrumentals without lyrics, and
duplicate mixes. Author confirmed 2026-09-14 that these originals are PD.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import subprocess
import unicodedata
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STAGING = Path(__file__).resolve().parent / "staging-freely"
ACQUIRED = date.today().isoformat()
GRANT = "grants/2026-09-14-andrew-case-pd.txt"
SOURCE = "andrew-case"
CC0 = "https://creativecommons.org/publicdomain/zero/1.0/"

GRANT_TEXT = f"""Andrew Case — public-domain dedication
Date recorded: {ACQUIRED}

Andrew Case confirmed to WorshipCommons that all original songs published at
https://hismagnificence.com/music/ are dedicated to the public domain (CC0).
That confirmation supersedes the “Copyright © 2008 … All Rights Reserved”
footer on some 2008 lyric PDFs.

Downloadable MP3s on those album pages are the writer's own recordings of
those originals, posted for free download.

Not covered by this grant (not imported): Sing Hebrew (skipped by request);
covers of other writers (Charlie Hall, David Ruis, Tomlin, Wickham, etc.);
ESV-labeled psalm settings; Coca-Cola jingle.
"""

# lyric_file is a stem under staging-freely/pdf-text/
SONGS = [
    # He is Your Life
    {"title": "He is Your Life", "lang": "English", "year": 2008, "themes": "Adoration,Salvation,Praise",
     "scripture": "1 Samuel 2:3", "page": "https://hismagnificence.com/he-is-your-life/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/He-Is-Your-Life.mp3",
     "lyric": "he-is-your-life"},
    {"title": "Garments of Salvation", "lang": "English", "year": 2008, "themes": "Salvation,Grace,Praise",
     "scripture": "Isaiah 61:10", "page": "https://hismagnificence.com/he-is-your-life/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Garments-of-Salvation.mp3",
     "lyric": "garments-of-salvation"},
    {"title": "Hast Thou Heard Him", "lang": "English", "year": 2008, "themes": "Adoration,Faith",
     "scripture": None, "writer": "Ora Rowan / Andrew Case", "page": "https://hismagnificence.com/he-is-your-life/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Hast-Thou-Heard-Him.mp3",
     "lyric": "hast-thou-heard-him"},
    {"title": "Awaken the Dawn", "lang": "English", "year": 2008, "themes": "Praise,Gathering,Faith",
     "scripture": "Psalm 108:2", "page": "https://hismagnificence.com/he-is-your-life/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Awaken-the-Dawn.mp3",
     "lyric": "awaken-the-dawn"},
    {"title": "Daisy's Dream", "lang": "English", "year": 2008, "themes": "Praise,Kids,Creation",
     "scripture": None, "page": "https://hismagnificence.com/he-is-your-life/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Daisys-Dream.mp3",
     "lyric": "daisys-dream"},
    {"title": "To Know Your Beauty", "lang": "English", "year": 2008, "themes": "Adoration,Prayer,Faith",
     "scripture": None, "page": "https://hismagnificence.com/he-is-your-life/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/To-Know-Your-Beauty.mp3",
     "lyric": "to-know-your-beauty"},
    {"title": "Sovereign Faithfulness", "lang": "English", "year": 2008, "themes": "Faith,Comfort,Praise",
     "scripture": "Psalm 103:13", "page": "https://hismagnificence.com/he-is-your-life/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Sovereign-Faithfulness.mp3",
     "lyric": "sovereign-faithfulness"},
    # Effulgent Grace
    {"title": "Light and Salvation", "lang": "English", "year": 2008, "themes": "Hope,Comfort,Salvation",
     "scripture": "Psalm 27:1", "page": "https://hismagnificence.com/effulgent-grace/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Light-and-Salvation.mp3",
     "lyric": "light-and-salvation"},
    # Exquisite Election
    {"title": "Lovely Christ", "lang": "English", "year": 2008, "themes": "Adoration,Trinity,Praise",
     "scripture": "Colossians 1:15", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Lovely-Christ.mp3",
     "lyric": "lovely-christ"},
    {"title": "Wondrous Things", "lang": "English", "year": 2008, "themes": "Praise,Adoration,Salvation",
     "scripture": "Psalm 72:18", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Wondrous-Things.mp3",
     "lyric": "wondrous-things"},
    {"title": "Exquisite Election", "lang": "English", "year": 2008, "themes": "Grace,Salvation,Praise",
     "scripture": "Ephesians 1:4", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Exquisite-Election.mp3",
     "lyric": "exquisite-election"},
    {"title": "Drawn to a Saviour", "lang": "English", "year": 2008, "themes": "Faith,Kids,Salvation",
     "scripture": None, "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Drawn-to-a-Saviour1.mp3",
     "lyric": "drawn-to-a-saviour"},
    {"title": "Deliciously Gracious", "lang": "English", "year": 2008, "themes": "Grace,Adoration,Prayer",
     "scripture": "Psalm 119:37", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Deliciously-Gracious.mp3",
     "lyric": "deliciously-gracious"},
    {"title": "Vessel of Beauty", "lang": "English", "year": 2008, "themes": "Creation,Praise,Adoration",
     "scripture": None, "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Vessel-of-Beauty.mp3",
     "lyric": "vessel-of-beauty"},
    {"title": "Who Is Like Him", "lang": "English", "year": 2008, "themes": "Adoration,Praise,Trinity",
     "scripture": "Exodus 15:11", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Who-Is-Like-Him.mp3",
     "lyric": "who-is-like-him"},
    {"title": "All My Boast", "lang": "English", "year": 2008, "themes": "Cross,Adoration,Faith",
     "scripture": "Galatians 6:14", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/All-My-Boast.mp3",
     "lyric": "all-my-boast"},
    {"title": "My Lover Loves Himself", "lang": "English", "year": 2008, "themes": "Adoration,Trinity",
     "scripture": None, "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/My-Lover-Loves-Himself.mp3",
     "lyric": "my-lover-loves-himself"},
    {"title": "He Commanded, She Was Created", "lang": "English", "year": 2008, "themes": "Creation,Praise,Kids",
     "scripture": "Psalm 148:5", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/He-Commanded-She-Was-Created.mp3",
     "lyric": "he-commanded-she-was-created"},
    {"title": "All Things for You", "lang": "English", "year": 2008, "themes": "Faith,Adoration,Hope",
     "scripture": "Philippians 1:21", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/All-Things-for-You.mp3",
     "lyric": "All-Things-for-You-burnley-mix"},
    {"title": "Have You Forgotten", "lang": "English", "year": 2008, "themes": "Hope,Comfort,Faith",
     "scripture": "Psalm 42:5", "page": "https://hismagnificence.com/exquisite-election/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Have-You-Forgotten.mp3",
     "lyric": "have-you-forgotten"},
    # Fractions / remixes originals
    {"title": "Fairytale Song", "lang": "English", "year": 2008, "themes": "Adoration,Praise",
     "scripture": None, "page": "https://hismagnificence.com/fractions-of-his-magnificence/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Fairytale-Song.mp3",
     "lyric": "fairytale-song"},
    {"title": "Feeble Knees", "lang": "English", "year": 2008, "themes": "Faith,Adoration,Cross",
     "scripture": "Philippians 2:9", "page": "https://hismagnificence.com/fractions-of-his-magnificence/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Feeble-Knees.mp3",
     "lyric": "feeble-knees"},
    {"title": "Alabaster", "lang": "English", "year": 2008, "themes": "Cross,Adoration,Grace",
     "scripture": "Luke 7:38", "page": "https://hismagnificence.com/fractions-of-his-magnificence/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Alabaster.mp3",
     "lyric": "alabaster"},
    {"title": "Tryst", "lang": "English", "year": 2008, "themes": "Adoration,Prayer",
     "scripture": None, "page": "https://hismagnificence.com/remixes-etc/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Tryst.mp3",
     "lyric": "tryst"},
    {"title": "Purest Love", "lang": "English", "year": 2008, "themes": "Adoration,Praise",
     "scripture": None, "page": "https://hismagnificence.com/remixes-etc/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Purest-Love-acoustic.mp3",
     "lyric": "purest-love"},
    # Alabanzas
    {"title": "Linda Cancion", "lang": "Spanish", "year": 2008, "themes": "Praise,Salvation,Faith",
     "scripture": None, "page": "https://hismagnificence.com/alabanzas/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Linda-Cancion.mp3",
     "lyric": "linda-cancion", "spanish_only": True},
    {"title": "Salmo 150", "lang": "Spanish", "year": 2008, "themes": "Praise,Adoration",
     "scripture": "Salmo 150", "page": "https://hismagnificence.com/alabanzas/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Salmo-1501.mp3",
     "lyric": "salmo-150"},
    {"title": "Salmo 145", "lang": "Spanish", "year": 2008, "themes": "Praise,Adoration",
     "scripture": "Salmo 145", "page": "https://hismagnificence.com/alabanzas/",
     "mp3": "https://hismagnificence.com/wp-content/uploads/2013/08/Salmo-145.mp3",
     "lyric": "salmo-145"},
]

LANG = {
    "English": "en", "Spanish": "es", "German": "de", "French": "fr", "Portuguese": "pt",
    "Russian": "ru", "Malayalam": "ml", "Albanian": "sq", "Hungarian": "hu",
    "Latin": "la", "Swedish": "sv", "Zulu": "zu",
}


def id_for(title: str) -> str:
    d = hashlib.sha1(f"wcsong:{title}".encode()).digest()
    return base64.urlsafe_b64encode(d).decode().rstrip("=")[:11]


def slugify(title: str) -> str:
    s = title.casefold()
    s = re.sub(r"['’ʼ]", "", s)
    s = re.sub(r"[^\w]+", "-", s, flags=re.UNICODE).replace("_", "-")
    return re.sub(r"-+", "-", s).strip("-") or "untitled"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1000:
        return
    req = urllib.request.Request(url, headers={"User-Agent": "WorshipCommonsHarvest/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def ffprobe_bpm(mp3: Path) -> int | None:
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "format=duration", "-of", "csv=p=0", str(mp3)],
            text=True, timeout=30)
        dur = float(out.strip() or 0)
    except Exception:
        dur = 0
    # no reliable beat tracker in this env; 80 is the catalog default for unknown contemporary
    return 80 if dur else None


def clean_lyrics(raw: str, title: str, spanish_only: bool = False) -> str:
    lines = [ln.rstrip() for ln in raw.splitlines()]
    body = []
    started = False
    for ln in lines:
        s = ln.strip()
        if re.search(r"Copyright|All Rights Reserved", s, re.I):
            continue
        if re.fullmatch(r"\d+", s):
            continue
        if not started:
            def compact(x):
                x = unicodedata.normalize("NFKD", x)
                x = "".join(c for c in x if not unicodedata.combining(c))
                x = x.lower().replace("&", "and").replace("…", " ")
                return re.sub(r"[^a-z0-9]+", "", x)
            norm, tnorm = compact(s), compact(title)
            if tnorm and norm and (tnorm in norm or norm in tnorm):
                started = True
            continue
        if spanish_only and s.startswith("I want to sing a beautiful song"):
            break
        if re.match(r"^(based on|by miss|written and recorded|piano:|bass|drums|loops|violin|percussion|\(en )", s, re.I):
            continue
        body.append(s)
    while body and not body[0]:
        body.pop(0)
    while body and not body[-1]:
        body.pop()
    # Split on blank lines, then on in-line numbered verses / Chorus:
    chunks, cur = [], []
    for ln in body:
        if ln.strip():
            cur.append(ln.strip())
        elif cur:
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    pieces = []
    for st in chunks:
        buf = []
        for ln in st:
            m = re.match(r"^(?:(\d+)\.|chorus:)\s*(.*)$", ln, re.I)
            if m and buf:
                pieces.append(buf)
                buf = [ln]
            else:
                buf.append(ln)
        if buf:
            pieces.append(buf)
    out = []
    chorus_re = re.compile(r"^chorus:", re.I)
    verse_n = 0
    for st in pieces:
        head = st[0]
        if chorus_re.match(head):
            label = "Chorus"
            rest = chorus_re.sub("", head).strip()
            lines = ([rest] if rest else []) + st[1:]
        elif re.match(r"^\d+\.", head):
            verse_n += 1
            label = f"Verse {verse_n}"
            lines = [re.sub(r"^\d+\.\s*", "", head)] + st[1:]
        else:
            verse_n += 1
            label = f"Verse {verse_n}"
            lines = st
        if not any(lines):
            continue
        out.append(label)
        out.extend(lines)
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def draft_form(body: str) -> dict | None:
    labels = []
    for ln in body.splitlines():
        t = re.sub(r"\[[^\]]*\]", "", ln).strip()
        if re.match(r"^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus)\b", t, re.I):
            labels.append(t)
    if not labels:
        return None
    seen, sections, n = {}, [], 0
    for lab in labels:
        if lab not in seen:
            n += 1
            seen[lab] = n
            sections.append({"label": lab, "lyric": n})
    return {"status": "draft", "sections": sections, "defaultOrder": labels}


def write_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def write_song(row: dict) -> str:
    title = row["title"]
    sid = id_for(title)
    folder = f"{slugify(title)}-{sid}"
    lang = LANG[row["lang"]]
    dir_ = ROOT / "songs" / lang / folder
    src = dir_ / "sources"
    src.mkdir(parents=True, exist_ok=True)
    (src / "grants").mkdir(exist_ok=True)
    (src / "master").mkdir(exist_ok=True)

    raw = (STAGING / "pdf-text" / f"{row['lyric']}.txt").read_text(encoding="utf-8")
    body = clean_lyrics(raw, title, row.get("spanish_only", False))
    if len(body) < 80:
        raise SystemExit(f"lyrics too short for {title!r}: {body!r}")

    mp3_dest = STAGING / "mp3" / f"{slugify(title)}.mp3"
    download(row["mp3"], mp3_dest)
    master = src / "master" / "song.mp3"
    shutil.copyfile(mp3_dest, master)
    bpm = ffprobe_bpm(mp3_dest)

    grant_path = src / GRANT
    grant_path.write_text(GRANT_TEXT, encoding="utf-8", newline="\n")

    header = [
        f"{{title: {title}}}",
        f"{{artist: {row.get('writer', 'Andrew Case')}}}",
        "{time: 4/4}",
    ]
    if bpm:
        header.append(f"{{tempo: {bpm}}}")
    lyrics = "\n".join(header) + "\n\n" + body
    (src / "lyrics.chordpro").write_text(lyrics, encoding="utf-8", newline="\n")

    form = draft_form(body)
    song = {
        "id": sid,
        "title": title,
        "writer": row.get("writer", "Andrew Case"),
        "year": row["year"],
        "language": row["lang"],
        "themes": row["themes"],
        "key": None,
        "bpm": bpm,
        "timeSignature": "4/4",
        "scripture": row.get("scripture"),
        "license": "PD",
        "licenseVersion": "CC0",
        "licenseUrl": CC0,
        "licenseSource": SOURCE,
        "rights": {
            "text": {
                "license": "PD",
                "basis": f"published {row['year']}",
                "version": "CC0",
                "url": CC0,
                "source": SOURCE,
            },
            "tune": {"license": "PD", "basis": SOURCE, "version": "CC0"},
            "arrangement": None,
            "recording": {
                "license": "PD",
                "basis": "writer MP3 download; PD dedication 2026-09-14",
                "version": "CC0",
                "source": SOURCE,
            },
            "artwork": None,
        },
        "form": form,
        "uploads": {"demoAudio": "song.mp3"},
    }
    write_json(dir_ / "song.json", song)

    files = []
    for rel, url, note, layer, extra in [
        ("lyrics.chordpro", row["page"], "Lyric sheet transcribed from the writer's PDF; PD by author confirmation", "text", {}),
        ("master/song.mp3", row["mp3"], "Writer-posted downloadable recording", "recording", {
            "evidence": GRANT, "submittedBy": "Andrew Case", "license": "PD", "licenseVersion": "CC0"
        }),
        (GRANT, row["page"], "Author confirmation that originals at hismagnificence.com/music are PD", "grant", {
            "submittedBy": "Andrew Case"
        }),
    ]:
        p = src / rel
        files.append({
            "file": rel,
            "url": url,
            "acquired": ACQUIRED,
            "sha256": sha256(p),
            "licenseBasis": SOURCE,
            "original": True,
            "submittedBy": extra.get("submittedBy", "Andrew Case" if layer == "recording" else None),
            "note": note,
            "obtainedVia": "harvest",
            "layer": layer,
            **{k: v for k, v in extra.items() if k != "submittedBy"},
        })
    write_json(src / "manifest.json", {"files": files})
    return f"songs/{lang}/{folder}"


def main() -> None:
    (STAGING / "mp3").mkdir(exist_ok=True)
    n = 0
    for row in SONGS:
        folder = write_song(row)
        print(f"wrote {folder}")
        n += 1
    print(f"imported {n} Andrew Case songs")


if __name__ == "__main__":
    main()
