"""Harvest Larry Holder worship songs from larryholdermusic.org.

License is the custom `larry-holder` grant (permissions page): non-profit church
use with credit; no translation; no lyric/melody changes. Elton Smith co-writes
are included (Elton granted under Larry's terms). Other co-writers, novelty
tracks, PD-hymn adaptations, and third-party photos are skipped.

  python tools/harvest/import-larry-holder.py
  python tools/harvest/import-larry-holder.py --dry-run
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html as htmlmod
import json
import re
import urllib.request
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[2]
STAGING = Path(__file__).resolve().parent / "staging-larry"
ACQUIRED = date.today().isoformat()
SOURCE = "larry-holder"
LICENSE_URL = "https://larryholdermusic.org/copyright.html"
BASE = "https://larryholdermusic.org/"
UA = {"User-Agent": "WorshipCommonsHarvest/1.0 (library ingest; +https://worshipcommons.org)"}

CATEGORIES = [
    "upbeatpraise.html",
    "firstcoming.html",
    "hisbirth.html",
    "jerusalemtocross.html",
    "secondcoming.html",
    "dailywalk.html",
    "quietpraise.html",
    "weddings.html",
    "specialsongs.html",
    "christaliveinme.html",
    "morethan.html",
]

SKIP_HREF = re.compile(
    r"(tomlascoemusic|youtube\.com|youtu\.be|itunes\.apple|"
    r"amazon\.com|facebook\.com|materials\.html|faq\.html|copyright\.html|"
    r"contact\.html|links\.html|index\.html|guestbook|justforfun|archives|"
    r"midi\.html|saxton/|graphics/|banners/|chordcharts/)",
    re.I,
)
ALLOWED_WRITERS = ("larry holder", "lawrence keith holder", "elton smith")
BLOCKED_WRITERS = (
    "rick founds", "dave laborde", "lee kurt", "steve israel", "gilberto",
    "tom lascoe", "rhesa siregar", "peter gringhuis", "susan tolle", "cathy smith",
    "andré esterhuyse", "andre esterhuyse",
)
HYMN_ADAPT = re.compile(r"adapted from the original hymn|herber\s*/\s*dykes", re.I)

GRANT = "grants/larry-holder-permissions.txt"
GRANT_TEXT = f"""Larry Holder Music — non-profit church-use grant
Date recorded: {ACQUIRED}

Source: {LICENSE_URL}

Copyright is retained. Unless a song page notes otherwise, Larry Holder grants
non-profit copy, worship use (perform, broadcast, display), internal arrangements,
and non-profit recordings (free, at cost, or ministry proceeds). Original credits
and notices must stay on every copy. Translation needs separate permission.
Changing lyrics or melody is not permitted. CCLI reporting is appreciated and
not required — the direct grant covers churches without CCLI.

For-profit website use (including pages with ads) needs ASCAP or direct permission.

Elton Smith co-writes listed from this site are included: Elton granted permission
under the same Larry Holder Music terms.

WorshipCommons hosts this as a custom writer grant, not PD/WC/CC. The song page
deed is a summary; the permissions page controls.
"""


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


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def fetch_text(url: str) -> str:
    raw = fetch(url)
    for enc in ("utf-8", "latin-1", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 500:
        return
    dest.write_bytes(fetch(url))


class LinkCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if href:
            self.hrefs.append(href)


def collect_song_urls() -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for page in CATEGORIES:
        url = urljoin(BASE, page)
        text = fetch_text(url)
        p = LinkCollector()
        p.feed(text)
        # the category page itself can be a song (christaliveinme, morethan)
        if page in ("christaliveinme.html", "morethan.html"):
            if url not in seen:
                seen.add(url)
                found.append(url)
        for href in p.hrefs:
            if SKIP_HREF.search(href or ""):
                continue
            absu = urljoin(BASE, href)
            host = urlparse(absu).netloc.lower()
            path = urlparse(absu).path.lower()
            if "songsofpraise.org" in host:
                if "song.php" not in path or "songid=" not in absu.lower():
                    continue
            elif host in ("larryholdermusic.org", "www.larryholdermusic.org"):
                if not path.endswith(".html"):
                    continue
                if any(x in path for x in ("/scores/", "/saxton/", "/graphics/")):
                    continue
            else:
                continue
            if absu not in seen:
                seen.add(absu)
                found.append(absu)
    return found


def strip_tags(html: str) -> str:
    html = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    html = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>", "\n", html)
    html = re.sub(r"(?is)</p>", "\n", html)
    html = re.sub(r"(?is)</div>", "\n", html)
    html = re.sub(r"(?is)</h[1-6]>", "\n", html)
    html = re.sub(r"(?is)<[^>]+>", " ", html)
    html = htmlmod.unescape(html)
    html = html.replace("\xa0", " ").replace("\u00a0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in html.replace("\r", "").split("\n")]
    out: list[str] = []
    blank = 0
    for ln in lines:
        if not ln:
            blank += 1
            if blank <= 1:
                out.append("")
            continue
        blank = 0
        out.append(ln)
    return "\n".join(out).strip()


def page_title(html: str, fallback: str) -> str:
    m = re.search(r"<h1[^>]*>\s*[\"“]?([^<\"”]+)[\"”]?\s*</h1>", html, re.I)
    if m:
        return htmlmod.unescape(m.group(1)).replace("\r", "").strip(" \t\"'")
    t = re.search(r"<title>([^<]+)</title>", html, re.I)
    if t:
        raw = htmlmod.unescape(t.group(1))
        raw = re.sub(r"\s*[—\-]\s*Larry.*$", "", raw, flags=re.I)
        return raw.replace("\r", "").strip(" \t\"'") or fallback
    return fallback.replace("\r", "").strip()


def copyright_year(text: str) -> int | None:
    chunk = re.split(r"Website Copyright", text, maxsplit=1, flags=re.I)[0]
    years = [int(y) for y in re.findall(r"Copyright\s*(?:©|&copy;)(?:\s*&\s*\(P\))?\s*(\d{4})", chunk, re.I)]
    if not years:
        years = [int(y) for y in re.findall(r"Copyright\s*(?:©|&copy;)\s*(\d{4})", chunk, re.I)]
    return max(years) if years else None


def file_links(html: str, page_url: str) -> dict[str, str]:
    p = LinkCollector()
    p.feed(html)
    mp3s, midis, pdfs = [], [], []
    for href in p.hrefs:
        absu = urljoin(page_url, href)
        path = urlparse(absu).path.lower()
        name = path.rsplit("/", 1)[-1]
        if path.endswith(".mp3"):
            mp3s.append(absu)
        elif path.endswith(".mid"):
            midis.append(absu)
        elif path.endswith(".pdf") and not re.search(r"writing|handwrit|tab|flute", name, re.I):
            pdfs.append(absu)
    out: dict[str, str] = {}
    vocal = [u for u in mp3s if not re.search(r"_acc|accomp|backing|guitar|practice|key_[a-g]", u, re.I)]
    pool = vocal or mp3s
    if pool:
        def yr(u: str) -> int:
            ys = [int(y) for y in re.findall(r"20\d{2}", u)]
            return max(ys) if ys else 0
        out["mp3"] = sorted(pool, key=yr, reverse=True)[0]
    if midis:
        plain = [u for u in midis if not re.search(r"rs\.mid", u, re.I)]
        out["midi"] = (plain or midis)[0]
    if pdfs:
        out["pdf"] = pdfs[0]
    return out


def lyrics_from_text(text: str, title: str) -> str | None:
    # Drop nav/footer chrome; keep the lyric stanzas.
    cut = re.split(r"Website Copyright", text, maxsplit=1, flags=re.I)[0]
    lines = cut.split("\n")
    # start at a line that looks like the title, after the copyright block if possible
    compact = re.sub(r"[^a-z0-9]+", "", title.casefold())
    start = None
    for i, ln in enumerate(lines):
        n = re.sub(r"[^a-z0-9]+", "", ln.casefold())
        if not compact or not n or i < 1:
            continue
        # exact title line (quotes/bold echo), not a lyric that merely contains the title
        if n == compact or n == compact + "iamyours":
            start = i + 1
            if i > 8:
                break
    if start is None:
        return None
    body: list[str] = []
    skipping_videos = False
    for ln in lines[start:]:
        if re.search(r"Website Copyright|cgi-sys/Count", ln, re.I):
            break
        if re.search(r"^(As of November \d{4}|This page and the YouTube)", ln, re.I):
            break
        if re.match(r"^YouTube Performances", ln, re.I):
            skipping_videos = True
            continue
        if skipping_videos:
            if re.match(r"^\[", ln) or re.match(r"^More than a child born", ln, re.I):
                skipping_videos = False
            else:
                continue
        if re.search(r"^(Feedback is appreciated|Photo ©|Art courtesy)", ln, re.I):
            continue
        if re.match(r"^\[\\", ln):
            continue
        body.append(ln)
    while body and not body[-1].strip():
        body.pop()
    skip_line = re.compile(
        r"^(words|music|arrangement|copyright|midi|mp3|for permissions|larry|lawrence keith|"
        r"ccli|ascap|151 charles|\[|feedback|youtube|used by permission|photo)",
        re.I,
    )
    while body:
        if not body[0].strip() or skip_line.match(body[0]):
            body.pop(0)
            continue
        break
    text_body = "\n".join(body).strip()
    if len(re.sub(r"\s+", "", text_body)) < 80:
        return None
    # label blank-line stanzas as verses
    chunks, cur = [], []
    for ln in text_body.split("\n"):
        if ln.strip():
            cur.append(ln.strip())
        elif cur:
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    out: list[str] = []
    n = 0
    for st in chunks:
        head = st[0]
        if re.match(r"^(verse|chorus|refrain|bridge|tag|intro|outro|pre-?chorus)\b", head, re.I):
            out.append(head)
            out.extend(st[1:])
        elif re.match(r"^\[(verse|chorus|bridge|tag)", head, re.I):
            out.append(re.sub(r"[\[\]]", "", head))
            out.extend(st[1:])
        else:
            n += 1
            out.append(f"Verse {n}")
            out.extend(st)
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


def is_allowed_writer(name: str) -> bool:
    low = name.casefold()
    return any(a in low for a in ALLOWED_WRITERS)


def parse_written_by(html: str, text: str) -> list[str]:
    m = re.search(
        r"(?:Written by|Words and Music by|Words\s*&\s*Music by)\s+([^<]{3,200}?)(?:<br|Links to|Copyright|$)",
        html,
        re.I | re.S,
    )
    raw = ""
    if m:
        raw = htmlmod.unescape(re.sub(r"<[^>]+>", " ", m.group(1)))
    else:
        m = re.search(
            r"(?:Written by|Words and Music by|Words\s*&\s*Music by)\s+(.+)",
            text,
            re.I,
        )
        raw = m.group(1) if m else ""
    raw = re.split(r"\n", raw, maxsplit=1)[0]
    parts = re.split(r"\s*(?:,| and | & |/)\s*", raw, flags=re.I)
    return [re.sub(r"\s+", " ", p).strip(" .") for p in parts if p.strip(" .")]


def writer_credit(names: list[str]) -> str:
    has_elton = any("elton" in n.casefold() for n in names)
    if has_elton:
        return "Larry Holder / Elton Smith"
    return "Larry Holder"


def skip_reason(html: str, text: str, url: str) -> str | None:
    path = urlparse(url).path.lower()
    if "justforfun" in path or path.rstrip("/").endswith("justforfun.html"):
        return "novelty"
    if HYMN_ADAPT.search(text):
        return "hymn adaptation"
    if re.search(r"kids' musical|a musical by larry holder for young voices", text, re.I):
        return "musical / not a single song"
    names = parse_written_by(html, text)
    extra = [n for n in names if n and not is_allowed_writer(n)]
    if extra:
        return "co-write (" + ", ".join(extra) + ")"
    if not names:
        head = text[:2500]
        if re.search(r"dave laborde|lee kurt|rick founds", head, re.I):
            return "co-write"
        if re.search(r"music from .*lee kurt", text, re.I):
            return "co-write"
    return None


def lyrics_from_sop(html: str) -> str | None:
    m = re.search(r'id="lyrics"(.*?)Copyright\s*(?:©|&copy;)', html, re.I | re.S)
    if not m:
        return None
    chunk = m.group(1)
    chunk = re.sub(r"(?is)<br\s*/?>", "\n", chunk)
    chunk = re.sub(r"(?is)</(p|div|h[1-6])>", "\n", chunk)
    chunk = re.sub(r"(?is)<[^>]+>", "", chunk)
    chunk = htmlmod.unescape(chunk)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in chunk.replace("\r", "").split("\n")]
    out: list[str] = []
    for ln in lines:
        if not ln:
            if out and out[-1] != "":
                out.append("")
            continue
        ln = re.sub(r"^\((verse|chorus|refrain|bridge|tag|intro|outro|ending|pre-?chorus)([^)]*)\)\s*$",
                    lambda x: x.group(1).title() + x.group(2), ln, flags=re.I)
        out.append(ln)
    text_body = "\n".join(out).strip()
    if len(re.sub(r"\s+", "", text_body)) < 80:
        return None
    return text_body + "\n"


def language_of(title: str, body: str) -> str:
    if re.search(r"[áéíóúñ¿¡]", title + body, re.I) and re.search(
        r"\b(el|la|los|las|que|por|con|mi|tu|jesús|señor|cristo)\b", (title + " " + body).casefold()
    ):
        if title.lower().startswith("tuyo") or "tuyo soy" in title.casefold():
            return "Spanish"
    return "English"


def write_song(url: str, html: str, text: str, files: dict[str, str], title: str, year: int, body: str, writer: str) -> Path:
    lang_name = language_of(title, body)
    lang = "es" if lang_name == "Spanish" else "en"
    sid = id_for(title)
    folder = f"{slugify(title)}-{sid}"
    pkg = ROOT / "songs" / lang / folder
    src = pkg / "sources"
    src.mkdir(parents=True, exist_ok=True)
    (src / "grants").mkdir(exist_ok=True)

    (src / GRANT).write_text(GRANT_TEXT, encoding="utf-8", newline="\n")
    lyrics = "\n".join([
        f"{{title: {title}}}",
        f"{{artist: {writer}}}",
        "{time: 4/4}",
        "{tempo: 80}",
        "",
        body.rstrip(),
        "",
    ])
    (src / "lyrics.chordpro").write_text(lyrics, encoding="utf-8", newline="\n")

    manifest: list[dict] = [{
        "file": GRANT,
        "url": LICENSE_URL,
        "acquired": ACQUIRED,
        "sha256": sha256(src / GRANT),
        "license": "larry-holder",
        "licenseBasis": SOURCE,
        "original": True,
        "submittedBy": "Larry Holder",
        "layer": "grant",
        "obtainedVia": "harvest",
        "evidence": GRANT,
    }, {
        "file": "lyrics.chordpro",
        "url": url,
        "acquired": ACQUIRED,
        "sha256": sha256(src / "lyrics.chordpro"),
        "license": "larry-holder",
        "licenseBasis": SOURCE,
        "original": False,
        "submittedBy": "Larry Holder",
        "layer": "text",
        "obtainedVia": "harvest",
        "evidence": GRANT,
    }]

    uploads: dict[str, str] = {}
    recording = None
    if files.get("mp3"):
        (src / "master").mkdir(exist_ok=True)
        dest = src / "master" / "song.mp3"
        download(files["mp3"], dest)
        manifest.append({
            "file": "master/song.mp3",
            "url": files["mp3"],
            "acquired": ACQUIRED,
            "sha256": sha256(dest),
            "license": "larry-holder",
            "licenseBasis": SOURCE,
            "original": True,
            "submittedBy": "Larry Holder",
            "layer": "recording",
            "obtainedVia": "harvest",
            "evidence": GRANT,
        })
        uploads["demoAudio"] = "song.mp3"
        recording = {
            "license": "larry-holder",
            "basis": "writer MP3 posted for free download; non-profit grant",
            "source": SOURCE,
        }
    if files.get("midi"):
        dest = src / "tune.mid"
        download(files["midi"], dest)
        manifest.append({
            "file": "tune.mid",
            "url": files["midi"],
            "acquired": ACQUIRED,
            "sha256": sha256(dest),
            "license": "larry-holder",
            "licenseBasis": SOURCE,
            "original": True,
            "submittedBy": "Larry Holder",
            "layer": "tune",
            "obtainedVia": "harvest",
            "evidence": GRANT,
        })
    if files.get("pdf"):
        dest = src / "sheetPdf.pdf"
        download(files["pdf"], dest)
        manifest.append({
            "file": "sheetPdf.pdf",
            "url": files["pdf"],
            "acquired": ACQUIRED,
            "sha256": sha256(dest),
            "license": "larry-holder",
            "licenseBasis": SOURCE,
            "original": True,
            "submittedBy": "Larry Holder",
            "layer": "arrangement",
            "obtainedVia": "harvest",
            "evidence": GRANT,
        })
        uploads["sheetPdf"] = "sheetPdf.pdf"

    form = draft_form(body)
    song = {
        "id": sid,
        "title": title,
        "writer": writer,
        "year": year,
        "language": lang_name,
        "themes": "Praise",
        "key": None,
        "bpm": 80,
        "timeSignature": "4/4",
        "scripture": None,
        "license": "larry-holder",
        "licenseVersion": "permissions",
        "licenseUrl": LICENSE_URL,
        "attribution": {
            "required": True,
            "text": writer,
            "link": "https://larryholdermusic.org/" if "Elton" not in writer else "https://larryholdermusic.org/copyright.html",
        },
        "rights": {
            "text": {
                "license": "larry-holder",
                "basis": "published on larryholdermusic.org / songsofpraise.org",
                "source": SOURCE,
                "url": LICENSE_URL,
            },
            "tune": {"license": "larry-holder", "basis": SOURCE} if files.get("midi") or files.get("mp3") else None,
            "arrangement": {"license": "larry-holder", "basis": SOURCE} if files.get("pdf") else None,
            "recording": recording,
            "artwork": None,
        },
        "form": form,
        "uploads": uploads or None,
    }
    if song["uploads"] is None:
        del song["uploads"]
    if song["form"] is None:
        del song["form"]
    write_json(pkg / "song.json", song)
    write_json(src / "manifest.json", {"files": manifest})
    return pkg


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    STAGING.mkdir(parents=True, exist_ok=True)

    urls = collect_song_urls()
    print(f"found {len(urls)} candidate pages")
    imported, skipped = [], []
    for url in urls:
        html = fetch_text(url)
        text = strip_tags(html)
        why = skip_reason(html, text, url)
        title = re.sub(r"\s+", " ", page_title(html, urlparse(url).path.rsplit("/", 1)[-1].replace(".html", ""))).strip()
        title = re.sub(r"^Songs of Praise:\s*", "", title, flags=re.I)
        if why:
            skipped.append((title, why, url))
            print(f"  skip {title} ({why})")
            continue
        year = copyright_year(text) or copyright_year(html) or 1997
        files = file_links(html, url)
        sop = "songsofpraise.org" in urlparse(url).netloc.lower()
        body = lyrics_from_sop(html) if sop else lyrics_from_text(text, title)
        if not body:
            skipped.append((title, "no lyrics parsed", url))
            print(f"  skip {title} (no lyrics parsed)")
            continue
        names = parse_written_by(html, text)
        writer = writer_credit(names)
        print(f"  take {title}  {year}  {writer}  files={list(files)}")
        if args.dry_run:
            imported.append(title)
            continue
        dest = ROOT / "songs" / ("es" if language_of(title, body) == "Spanish" else "en") / f"{slugify(title)}-{id_for(title)}"
        if (dest / "song.json").exists():
            print(f"    have {dest.name}")
            imported.append(str(dest.relative_to(ROOT)))
            continue
        pkg = write_song(url, html, text, files, title, year, body, writer)
        imported.append(str(pkg.relative_to(ROOT)))
        print(f"    -> {pkg.relative_to(ROOT)}")

    print(f"imported {len(imported)}, skipped {len(skipped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
