"""Harvest Larry Holder worship songs from larryholdermusic.org.

License is the custom `larry-holder` grant (permissions page): non-profit church
use with credit; no translation; no lyric/melody changes. Elton Smith co-writes
are included (Elton granted under Larry's terms). Other co-writers, novelty
tracks, PD-hymn adaptations, and third-party photos are skipped.

  python tools/harvest/import-larry-holder.py
  python tools/harvest/import-larry-holder.py --dry-run
  python tools/harvest/import-larry-holder.py --refresh   # re-parse existing packages
  python tools/harvest/import-larry-holder.py --selftest  # parser checks, no network
  python tools/harvest/import-larry-holder.py --chords [--only <slug>] [--dry-run]  # merge writer chord charts
  python tools/harvest/import-larry-holder.py --strip-chrome [--dry-run]  # drop copyright/credit preamble from existing packages
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html as htmlmod
import json
import re
import urllib.request
import mido
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

# category page -> theme (themes.json vocabulary). The site's own shelving is the only
# theme evidence we have; "Praise" is the catch-all for the praise/daily-walk shelves.
CATEGORIES = {
    "upbeatpraise.html": "Praise",
    "firstcoming.html": "Advent",
    "hisbirth.html": "Christmas",
    "jerusalemtocross.html": "Cross",
    "secondcoming.html": "Hope",
    "dailywalk.html": "Praise",
    "quietpraise.html": "Adoration",
    "weddings.html": "Wedding",
    "specialsongs.html": "Praise",
    "christaliveinme.html": "Praise",
    "morethan.html": "Christmas",
}

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


def collect_song_urls() -> dict[str, str]:
    found: dict[str, str] = {}
    seen: set[str] = set()
    for page, theme in CATEGORIES.items():
        url = urljoin(BASE, page)
        text = fetch_text(url)
        p = LinkCollector()
        p.feed(text)
        # the category page itself can be a song (christaliveinme, morethan)
        if page in ("christaliveinme.html", "morethan.html"):
            if url not in seen:
                seen.add(url)
                found[url] = theme
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
                found[absu] = theme
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


def copyright_lines(html: str) -> list[str]:
    """The page's own copyright notice, verbatim, one line per notice (a translation adds its own).
    Goes into song.json `copyright`; never composed from writer + year."""
    text = htmlmod.unescape(re.sub(r"<[^>]+>", "\n", re.sub(r"(?is)<(script|style)\b.*?</\1>", "", html)))
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()]
    end = next((i for i, ln in enumerate(lines) if re.match(r"Website Copyright|Copyright\s*©\s*\d{4}-\d{4}", ln, re.I)), len(lines))
    out = [ln for ln in lines[:end] if re.match(r"(Translation )?Copyright\s*©", ln)]
    if not any(ln.startswith("Translation Copyright") for ln in out):
        out += [ln for ln in lines[:end] if ln.startswith("Translation by")]
    return [part for ln in out for part in re.split(r"\s+(?=Additional translation by)", ln)]


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
    chosen = set(out.values())
    out["extra"] = [u for u in mp3s + midis + pdfs if u not in chosen]  # granted, kept, never processed
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
    text_body = drop_chrome_paragraphs("\n".join(body).strip(), title)
    if len(re.sub(r"\s+", "", text_body)) < 80:
        return None
    return label_stanzas(text_body)


SECTION = r"verse|chorus|refrain|bridge|tag|intro|outro|ending|coda|pre-?chorus"
DROP_DIRECTION = re.compile(
    r"^\(?\s*(?:\d+\s+measures?\s+|short\s+|brief\s+|piano\s+|guitar\s+|instrumental\s+)?"
    r"(introduction|intro|interlude|instrumental|solo|change keys?|key change|modulat\w*|turnaround|ending)\s*\)?$", re.I)


def label_stanzas(text_body: str) -> str:
    """Turn the site's italic stage directions into section labels and cues.

    (Mary sings verse 1) -> "Verse 1" + {c: Mary};  (Bridge) -> "Bridge";  (Elizabeth) -> {c: Elizabeth};
    (Introduction) / (Change keys) -> dropped.  Unlabelled stanzas become Verse n, except that an
    unlabelled stanza right after a Verse is that verse's second half (this site breaks a verse and
    its built-in refrain with a blank line, and labels only the verse).
    """
    chunks, cur = [], []
    for ln in text_body.split("\n"):
        if ln.strip():
            cur.append(ln.strip())
        elif cur:
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    # an unlabelled stanza that recurs verbatim is the chorus, whatever the site called it
    norm = lambda st: re.sub(r"[^a-z]", "", " ".join(st).casefold())
    counts: dict[str, int] = {}
    for st in chunks:
        counts[norm(st)] = counts.get(norm(st), 0) + 1
    out: list[list[str]] = []
    n, explicit = 0, False
    for st in chunks:
        label, lines = None, []
        if counts[norm(st)] > 1 and not re.match(rf"^\[?\(?\s*(?:{SECTION})", st[0], re.I):
            label = "Chorus"
        for ln in st:
            t = ln.strip()
            if DROP_DIRECTION.match(t):
                continue
            m = re.match(rf"^\[?\(?\s*(?:(?P<who>[A-Z][\w' ]*?)\s+sings?\s+)?(?P<sec>(?:{SECTION})\s*\d*)(?:\s+together)?\s*\)?\]?:?$", t, re.I)
            if m and label is None and not lines:
                label = m.group("sec").strip().title()
                if m.group("who"):
                    lines.append(f"{{c: {m.group('who').strip()}}}")
                continue
            m = re.match(r"^\(([^)]{1,60})\)$", t)
            if m:
                lines.append(f"{{c: {m.group(1).strip()}}}")
                continue
            lines.append(t)
        if not any(not l.startswith("{c:") for l in lines):
            continue
        if label is None and out and explicit and re.match(r"^Verse", out[-1][0]):
            out[-1].extend(lines)  # ponytail: continuation of a source-labelled verse — see docstring
            continue
        explicit = label is not None
        if label is None:
            n += 1
            label = f"Verse {n}"
        elif re.match(r"^Verse \d", label):
            n = max(n, int(label.split()[1]))
        out.append([label, *lines])
    return "\n\n".join("\n".join(st) for st in out).rstrip() + "\n"


def bare_lyric(ln: str) -> str:
    return re.sub(r"\[[^\]]*\]", "", ln).strip().strip("\"“”")


CHROME_LINE = re.compile(
    r"^(?:"
    r"inspired by\b|based on\b|adapted from\b|"
    r"words(?:\s*(?:,|&|and)\s*music)?(?:\s+by)\b|"
    r"words(?:\s*(?:,|&|and)\s*music)\b|"
    r"music(?:\s+and\s+additional\s+words)?\s+by\b|"
    r"lyrics by\b|written by\b|arranged by\b|orchestrat|"
    r"with thanks to\b|copyright\b|©|\(c\)|\(p\)|song copyright\b|"
    r"ccli\b|ascap\b|larry holder music|larry'?s songs of praise|for permissions\b|"
    r"151 charles|larry@|and let me know what you think|of outreach\.?$|"
    r"new recording\b|live performance by\b|choir and piano:|"
    r"orchestration track|full orchestral score|available by request|"
    r"there is also a .+translation|"
    r"midi sequence copyright|arrangement copyright|a musical for young voices|"
    r"by (?:larry holder|lawrence keith holder|chuck brown|elton smith)|"
    r"words music by\b|\(larry holder music|non-profit copying|for details,? see|"
    r"click here\b|this zipped file|mp3 (?:files|recording|available)|"
    r"may be heard|soundclick\.|tunesmithfiles|unzipped samples|dramatization text|"
    r"song \d+,|for more good children|for anyone who has a lost|"
    r"don'?t ever give up|thanks,\s+\w+,?\s+for providing|i'?ve also enhanced|"
    r"this page and the youtube|used by permission|feedback is appreciated|"
    r"photo ©|art courtesy|and (?:larry|lawrence|elton|chuck|lena|peter|mark|deborah)\b|"
    r"recording copyright|additional words and music|^by [A-Z][a-z]+ [A-Z]"
    r")",
    re.I,
)
WRITER_ONLY = re.compile(
    r"^(?:and )?(?:larry holder|lawrence keith holder|elton smith|chuck brown|"
    r"lena kittrell|rh\w*a siregar|peter gringhuis|mark wilkinson|"
    r"deborah johnson|dennis and deborah johnson|charlie pierson|"
    r"johnson/?pierson/?holder)\.?$",
    re.I,
)
ASSET_BRACKET = re.compile(
    r"^\[(?:MIDI File|Lead Sheet|Choral arrangement|Sheet Music|Page \d+|\\).*$",
    re.I,
)
CHORD_TOKEN = re.compile(r"^[A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?\d*(?:/[A-G][#b]?)?$")
NOTE_STANZA = re.compile(
    r"(?is)(?:"
    r"this song was written|this song has been arranged|this song is featured|"
    r"another musical collaboration|this is an honest retrospective|"
    r"this is another collaboration|this is my second collaboration|"
    r"here is another song that originated|i wrote this|i wrote the words|"
    r"may it be a blessing|flute arrangement dedicated|to celebrate the arrival|"
    r"shepherd is referring to the minister|he wrote the music, and i added|"
    r"i later added an optional|don't ever give up, don't ever stop praying|"
    r"for anyone who has a lost family member|thanks, elton, for providing|"
    r"this zipped file contains|for more good children's music|"
    r"non-profit copying and use is encouraged|complete dramatization text|"
    r"let me know what you think of this song|i originally composed this song|"
    r"computer programmer and composer|this is (?:my|our) (?:first|second|another)|"
    r"in hopes of playing|in the near future with my|it can also be played|"
    r"the recording was done|here'?s an upbeat|visit (?:his|her|rhesa)'?s website|"
    r"hang on, this one rocks|the answer, of course|i wrote the lyrics as|"
    r"i wrote this song while|looking back now|host our collaborations|"
    r"mark plans to build a website|you can visit his website|"
    r"he writes wonderful melodies|be sure to visit|this is an adaptation|"
    r"you can also email|of outreach|living in your own strength"
    r")",
)
REPEAT_CUE = re.compile(r"^(?:repeat(?:ing)?\s+(?:the\s+)?(?:chorus|refrain|verse)\b|chorus again)\b", re.I)
SECTION_LABEL = re.compile(rf"^(?:{SECTION})\b", re.I)


def is_title_only(text: str, title: str) -> bool:
    if not title:
        return False
    a = re.sub(r"[^a-z0-9]+", "", text.casefold())
    b = re.sub(r"[^a-z0-9]+", "", title.casefold())
    return bool(a) and a == b


def is_chrome_line(ln: str, title: str = "") -> bool:
    raw = ln.strip()
    if ASSET_BRACKET.match(raw):
        return True
    t = bare_lyric(ln)
    if not t:
        inner = raw.strip("[]").strip()
        return bool(inner) and not CHORD_TOKEN.match(inner) and not SECTION_LABEL.match(inner)
    inner = t[1:-1].strip() if t.startswith("(") and t.endswith(")") else t
    if SECTION_LABEL.match(t) or SECTION_LABEL.match(inner):
        return False
    if re.search(r"\bcopyright\b|\bascap\b|\bccli\b", inner, re.I):
        return True
    if re.search(r"words\s*(?:&|and)?\s*music\s+by", inner, re.I):
        return True
    if re.search(r"larry holder music", inner, re.I):
        return True
    if re.match(r"^by [A-Z]", inner, re.I) and re.search(
        r"holder|siregar|kittrell|gringhuis|wilkinson|brown|elton smith", inner, re.I
    ):
        return True
    if DROP_DIRECTION.match(inner) or re.search(r"\d+-measures?\s+intro|\bkey change\b", inner, re.I):
        return True
    if title:
        ct = re.sub(r"[^a-z0-9]+", "", inner.casefold())
        ctitle = re.sub(r"[^a-z0-9]+", "", title.casefold())
        if ctitle and ct.startswith(ctitle) and re.search(r"words|copyright|music by|arranged", inner, re.I):
            return True
    return bool(
        CHROME_LINE.match(inner) or WRITER_ONLY.match(inner) or REPEAT_CUE.match(inner)
    )


def split_stanzas(text: str) -> list[list[str]]:
    chunks, cur = [], []
    for ln in text.split("\n"):
        if ln.strip():
            cur.append(ln.rstrip())
        elif cur:
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    return chunks


def drop_chrome_paragraphs(text: str, title: str = "") -> str:
    """Remove credit/copyright/site-note paragraphs from unlabeled page text."""
    out: list[list[str]] = []
    for st in split_stanzas(text):
        kept = [ln for ln in st if ln.strip() and not is_chrome_line(ln, title)]
        if not kept:
            continue
        if all(is_title_only(bare_lyric(x), title) for x in kept):
            continue
        joined = " ".join(bare_lyric(x) for x in kept)
        if NOTE_STANZA.search(joined):
            continue
        out.append(kept)
    return "\n\n".join("\n".join(st) for st in out)


def strip_labeled_chrome(body: str, title: str = "") -> str:
    """Drop credit/copyright stanzas from an already-labelled ChordPro body.

    Returns the original body unchanged when nothing was chrome, so clean
    packages (and translations whose first line is the title) are left alone.
    """
    out: list[tuple[str, list[str]]] = []
    dropped = False
    verse_n = 0
    for st in split_stanzas(body):
        orig_label: str | None = None
        lines = list(st)
        head = bare_lyric(lines[0])
        bracket = re.match(rf"^\[((?:{SECTION})\s*\d*)\]$", lines[0].strip(), re.I)
        if bracket:
            orig_label = bracket.group(1)
            lines = lines[1:]
        elif SECTION_LABEL.match(head) and not re.search(r"\[[^\]]+\]", lines[0]):
            orig_label = lines[0].strip()
            lines = lines[1:]
        kept: list[str] = []
        for ln in lines:
            if not ln.strip():
                continue
            if is_chrome_line(ln, title):
                dropped = True
                continue
            kept.append(ln)
        if kept:
            t0 = bare_lyric(kept[0])
            m = re.match(r"^\((.+?)\)?:?$", t0)
            if m:
                inner = m.group(1).strip()
                if SECTION_LABEL.match(inner) or re.match(r"^first verse\b", inner, re.I):
                    orig_label = inner.rstrip(":")
                    kept = kept[1:]
                    dropped = True
                elif (
                    REPEAT_CUE.match(inner)
                    or re.match(r"^\d+$", inner)
                    or DROP_DIRECTION.match(inner)
                    or DROP_DIRECTION.match(t0)
                ):
                    kept = kept[1:]
                    dropped = True
        if kept and all(is_title_only(bare_lyric(x), title) for x in kept):
            dropped = True
            kept = []
        while (
            kept
            and len(kept) > 1
            and is_title_only(bare_lyric(kept[0]), title)
            and re.match(r"^\d+\.", bare_lyric(kept[1]))
        ):
            kept.pop(0)
            dropped = True
        if not kept:
            if orig_label:
                dropped = True
            continue
        joined = " ".join(bare_lyric(x) for x in kept if not bare_lyric(x).startswith("{c:"))
        if NOTE_STANZA.search(joined):
            dropped = True
            continue
        if not any(not bare_lyric(x).startswith("{c:") for x in kept):
            dropped = True
            continue
        if orig_label is None or re.match(r"^verse\b", orig_label, re.I) or re.match(r"^first verse\b", orig_label, re.I):
            verse_n += 1
            if orig_label and re.match(rf"^verse\s+{verse_n}:?$", orig_label, re.I):
                pass  # keep "Verse 1:" when the number is already right
            else:
                orig_label = f"Verse {verse_n}"
        out.append((orig_label, kept))
    if not dropped:
        return body if body.endswith("\n") else body + "\n"
    if not out:
        return ""
    return "\n\n".join(lab + "\n" + "\n".join(ls) for lab, ls in out) + "\n"


def midi_meta(p: Path) -> dict:
    """tempo / key / time from the writer's MIDI, else {}."""
    try:
        mf = mido.MidiFile(p)
    except Exception:
        return {}
    out: dict = {}
    for tr in mf.tracks:
        for msg in tr:
            if msg.type == "set_tempo" and "bpm" not in out:
                out["bpm"] = int(round(mido.tempo2bpm(msg.tempo)))
            elif msg.type == "key_signature" and "key" not in out:
                out["key"] = msg.key
            elif msg.type == "time_signature" and "time" not in out:
                out["time"] = f"{msg.numerator}/{msg.denominator}"
    return out


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


CCLI_RE = re.compile(r"CCLI\s*(?:Song\s*I[dD]|#|No\.?|Number)?\s*[:#]?\s*(\d{5,8})", re.I)


def parse_ccli(html: str, text: str) -> str | None:
    m = CCLI_RE.search(html) or CCLI_RE.search(text)
    return m.group(1) if m else None


def is_allowed_writer(name: str) -> bool:
    low = name.casefold()
    return any(a in low for a in ALLOWED_WRITERS)


CREDIT_LINE = re.compile(
    r"(?:^|[.;,]\s*)(?:written|words(?:\s*(?:,|and|&)\s*music)?(?:\s*(?:,|and|&)\s*arrangement)?|music|lyrics)\s+by\s+(.+?)(?=(?:,\s*)?(?:words|music|lyrics)\s+by\s|\.\s*$|$)",
    re.I,
)


def parse_written_by(html: str, text: str) -> list[str]:
    """Every name on a Written by / Words by / Music by line in the page header.

    Handles "Music by Mark Wilkinson, Words by Larry Holder." on one line and a credit that
    wraps onto an "and Rick Founds" continuation line. Singers, sequencers and photo credits are
    other verbs and are not writers.
    """
    lines = [ln.strip() for ln in text.split("\n")]
    names: list[str] = []
    for i, ln in enumerate(lines[:120]):
        if not re.search(r"\b(?:written|words|music|lyrics)\b[^\n]{0,40}\bby\b", ln, re.I):
            continue
        raw = ln
        j = i + 1
        while j < len(lines) and re.match(r"^(?:and|&|,|y|e)\s+\S", lines[j], re.I):
            raw += " " + lines[j]
            j += 1
        for m in CREDIT_LINE.finditer(raw):
            names += re.split(r"\s*(?:,| and | & |/| y | e )\s*", m.group(1), flags=re.I)
    out: list[str] = []
    for n in names:
        n = re.sub(r"\s+", " ", n).strip(" .")
        n = re.sub(r"\s*\(.*?\)\s*$", "", n)
        n = re.sub(r"^(?:and|&|y|e)\s+", "", n, flags=re.I)
        if n and n.casefold() not in ("and", "y", "e") and n not in out:
            out.append(n)
    return out


def writer_credit(names: list[str]) -> str:
    # the site's order, as printed ("Elton Smith and Larry Holder" stays that way)
    canon = {"lawrence keith holder": "Larry Holder"}
    names = [canon.get(n.casefold(), n) for n in names if is_allowed_writer(n)]
    return " / ".join(dict.fromkeys(names)) or "Larry Holder"


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
        if re.search("|".join(map(re.escape, BLOCKED_WRITERS)), head, re.I):
            return "co-write"
        if re.search(r"music from .*lee kurt", text, re.I):
            return "co-write"
    return None


def lyrics_from_sop(html: str) -> str | None:
    m = re.search(r'id="lyrics".*?</header>(.*?)Copyright\s*(?:©|&copy;)', html, re.I | re.S)
    if not m:
        return None
    chunk = m.group(1).replace("\r", "").replace("\n", " ")  # the HTML's own newlines are noise; <BR> is the line break
    chunk = re.sub(r"(?is)<br\s*/?>", "\n", chunk)
    chunk = re.sub(r"(?is)</(p|div|h[1-6])>", "\n", chunk)
    chunk = re.sub(r"(?is)<[^>]+>", "", chunk)
    chunk = htmlmod.unescape(chunk)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in chunk.replace("\r", "").split("\n")]
    text_body = drop_chrome_paragraphs("\n".join(lines).strip(), "")
    if len(re.sub(r"\s+", "", text_body)) < 80:
        return None
    return label_stanzas(text_body)


def language_of(title: str, body: str) -> str:
    if re.search(r"[áéíóúñ¿¡]", title + body, re.I) and re.search(
        r"\b(el|la|los|las|que|por|con|mi|tu|jesús|señor|cristo)\b", (title + " " + body).casefold()
    ):
        if title.lower().startswith("tuyo") or "tuyo soy" in title.casefold():
            return "Spanish"
    return "English"


def write_song(url: str, html: str, text: str, files: dict, title: str, year: int, body: str, writer: str, theme: str = "Praise") -> Path:
    lang_name = language_of(title, body)
    lang = "es" if lang_name == "Spanish" else "en"
    sid = id_for(title)
    folder = f"{slugify(title)}-{sid}"
    pkg = ROOT / "songs" / lang / folder
    src = pkg / "sources"
    src.mkdir(parents=True, exist_ok=True)
    (src / "grants").mkdir(exist_ok=True)

    (src / GRANT).write_text(GRANT_TEXT, encoding="utf-8", newline="\n")
    prev = json.loads((pkg / "song.json").read_text(encoding="utf-8")) if (pkg / "song.json").exists() else {}
    prev_rows = {}
    if (src / "manifest.json").exists():
        prev_rows = {r["file"]: r for r in json.loads((src / "manifest.json").read_text(encoding="utf-8"))["files"]}

    meta = {}
    if files.get("midi"):
        download(files["midi"], src / "tune.mid")
        meta = midi_meta(src / "tune.mid")
    bpm = meta.get("bpm") or 80  # ponytail: 80 is the catalog default when nothing says otherwise
    key = meta.get("key")
    time_sig = meta.get("time") or "4/4"
    lyrics = "\n".join([
        f"{{title: {title}}}",
        f"{{artist: {writer}}}",
        *([f"{{key: {key}}}"] if key else []),
        f"{{time: {time_sig}}}",
        f"{{tempo: {bpm}}}",
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
    for u in files.get("extra", []):
        name = urlparse(u).path.rsplit("/", 1)[-1]
        dest = src / "extra" / name
        download(u, dest)
        manifest.append({
            "file": f"extra/{name}",
            "url": u,
            "acquired": ACQUIRED,
            "sha256": sha256(dest),
            "license": "larry-holder",
            "licenseBasis": SOURCE,
            "original": True,
            "submittedBy": "Larry Holder",
            "layer": {"mp3": "recording", "mid": "tune"}.get(name.rsplit(".", 1)[-1].lower(), "arrangement"),
            "obtainedVia": "harvest",
            "evidence": GRANT,
            "note": "Granted alongside the song; kept as-is, not processed",
        })
    # rows this importer does not own (timing.json, cover.webp, ...) survive a --refresh
    mine = {r["file"] for r in manifest}
    manifest.extend(r for f, r in prev_rows.items() if f not in mine and (src / f).exists())

    form = draft_form(body)
    themes = prev.get("themes") if prev.get("themes") not in (None, "", "Praise") else theme
    song = {
        "id": sid,
        "title": title,
        "writer": writer,
        "year": year,
        "language": lang_name,
        "themes": themes,
        "key": key,
        "bpm": bpm,
        "timeSignature": time_sig,
        "scripture": prev.get("scripture"),
        "license": "larry-holder",
        "licenseVersion": "permissions",
        "licenseUrl": LICENSE_URL,
        "ccli": parse_ccli(html, text),
        **({"copyright": "\n".join(copyright_lines(html))} if copyright_lines(html) else {}),
        "attribution": {
            "required": True,
            "text": writer,
            "link": "https://larryholdermusic.org/" if "Elton" not in writer else "https://larryholdermusic.org/copyright.html",
        },
        **({"ccli": prev["ccli"]} if prev.get("ccli") else {}),
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
    if not song["ccli"]:
        del song["ccli"]
    write_json(pkg / "song.json", song)
    write_json(src / "manifest.json", {"files": manifest})
    return pkg


def backfill_ccli(dry_run: bool) -> int:
    import time
    n = 0
    for song_path in sorted((ROOT / "songs").glob("*/*/song.json")):
        song = json.loads(song_path.read_text(encoding="utf-8"))
        if song.get("license") != "larry-holder":
            continue
        man = song_path.parent / "sources" / "manifest.json"
        if not man.exists():
            continue
        files = json.loads(man.read_text(encoding="utf-8")).get("files") or []
        url = next((f.get("url") for f in files if f.get("file") == "lyrics.chordpro"), None)
        if not url:
            continue
        html = fetch_text(url)
        ccli = parse_ccli(html, strip_tags(html))
        print(f"  {song.get('title')}: {ccli or '—'}")
        if ccli and song.get("ccli") != ccli and not dry_run:
            song["ccli"] = ccli
            write_json(song_path, song)
            n += 1
        time.sleep(0.4)
    print(f"updated {n} song.json files")
    return 0


CHART_LABELS = {"REPEAT CHORUS": "Chorus", "TAG": "Tag", "ENDING": "Ending"}
CHART_DROP = re.compile(r"(INTRODUCTION|INTRO|INTERLUDE)$")  # "(Cello Introduction)" too: chord-only


def parse_chord_chart(html: str) -> tuple[str | None, list[tuple[str, list[str]]]]:
    """(chart key, [(section label, chordpro lines)...]) from a songsofpraise.org chordchart page.

    Sections are a one-cell "(VERSE 1)" table; each lyric line is a two-row table, chords over
    fragments, cell i over cell i. A fragment ending in &nbsp; keeps a space; "God A-" + "bove" joins.
    """
    m = re.search(r"<title>[^<]*\(([A-G][b#]?m?)\)[^<]*</title>", html, re.I)
    key = m.group(1) if m else None
    cell = lambda c: htmlmod.unescape(re.sub(r"(?is)<[^>]+>", "", c))
    sections: list[tuple[str | None, list[str]]] = []
    chorus: list[str] = []
    for attrs, body in re.findall(r"(?is)<table\b([^>]*)>(.*?)</table>", html):
        if "do_not_print_me" in attrs:
            continue
        rows = [re.findall(r"(?is)<td[^>]*>(.*?)</td>", r) for r in re.findall(r"(?is)<tr>(.*?)</tr>", body)]
        chords = [cell(c).replace("\xa0", "").strip() for c in rows[0]] if rows else []
        # "(VERSE 1)" as a one-cell table, or "(Chorus)" as a chord-less lyric row
        head = cell(rows[-1][0]).strip() if rows and len(rows[-1]) == 1 and (len(rows) == 1 or not any(chords)) else ""
        if re.match(r"^\(.+\)$", head):
            name = re.sub(r"^REPEAT CHORUS.*", "REPEAT CHORUS", head.strip("() ").upper())
            sections.append((None if CHART_DROP.search(name) else CHART_LABELS.get(name, name.title()), []))
            continue
        if len(rows) != 2 or not sections or sections[-1][0] is None:
            continue
        line = ""
        for i, frag in enumerate(rows[1]):
            t = cell(frag)
            c = chords[i] if i < len(chords) else ""
            line += (f"[{c}]" if c else "") + t.replace("\xa0", "").strip() + (" " if t.endswith("\xa0") else "")
        if line.strip():
            sections[-1][1].append(line.strip())
    out: list[tuple[str, list[str]]] = []
    for label, lines in sections:
        if label is None:
            continue
        if label == "Chorus":
            lines = lines or list(chorus)  # (REPEAT CHORUS) with an empty body means the chorus above
            chorus = chorus or lines
        if lines:
            out.append((label, lines))
    return key, out


def backfill_chords(dry_run: bool, only: str | None) -> int:
    import time
    n = 0
    for song_path in sorted((ROOT / "songs").glob("*/*/song.json")):
        if only and only not in song_path.parent.name:
            continue
        song = json.loads(song_path.read_text(encoding="utf-8"))
        if song.get("license") != "larry-holder":
            continue
        src = song_path.parent / "sources"
        man_path = src / "manifest.json"
        if not man_path.exists():
            continue
        manifest = json.loads(man_path.read_text(encoding="utf-8"))
        row = next((f for f in manifest.get("files") or [] if f.get("file") == "lyrics.chordpro"), None)
        if not row or not row.get("url"):
            continue
        page = fetch_text(row["url"])
        time.sleep(0.4)
        m = re.search(r'href="([^"]*chordchart\.php\?song=[^"]+)"', page, re.I)
        if not m:
            print(f"  {song.get('title')}: no chart")
            continue
        chart_url = urljoin(row["url"], htmlmod.unescape(m.group(1)))
        key, sections = parse_chord_chart(fetch_text(chart_url))
        time.sleep(0.4)
        nlines = sum(len(l) for _, l in sections)
        print(f"  {song.get('title')}: key {key or '?'}  {nlines} chord lines")
        if not sections or dry_run:
            continue
        lp = src / "lyrics.chordpro"
        header = [ln for ln in lp.read_text(encoding="utf-8").splitlines() if ln.startswith("{") and not ln.startswith("{key:")]
        if key:
            header.insert(2, f"{{key: {key}}}")
        body = strip_labeled_chrome(
            "\n\n".join("\n".join([label, *lines]) for label, lines in sections),
            song.get("title") or "",
        )
        lp.write_text("\n".join(header) + "\n\n" + body.rstrip() + "\n", encoding="utf-8", newline="\n")
        row["chords"] = chart_url
        row["sha256"] = sha256(lp)
        write_json(man_path, manifest)
        n += 1
    print(f"updated {n} lyrics.chordpro files")
    return 0


def split_header(text: str) -> tuple[list[str], str]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith("{"):
        i += 1
    if i < len(lines) and lines[i] == "":
        i += 1
    return lines[:i], "\n".join(lines[i:])


def strip_existing(dry_run: bool) -> int:
    n = 0
    for song_path in sorted((ROOT / "songs").glob("*/*/song.json")):
        song = json.loads(song_path.read_text(encoding="utf-8"))
        if song.get("license") != "larry-holder":
            continue
        lp = song_path.parent / "sources" / "lyrics.chordpro"
        if not lp.exists():
            continue
        raw = lp.read_text(encoding="utf-8")
        header, body = split_header(raw)
        cleaned = strip_labeled_chrome(body, song.get("title") or "")
        if cleaned.rstrip("\n") == body.rstrip("\n"):
            continue
        if len(re.sub(r"\s+", "", re.sub(r"\{[^}]+\}", "", cleaned))) < 80:
            print(f"  skip {song.get('title')}: would leave too little lyric text")
            continue
        first = next((bare_lyric(ln) for ln in cleaned.splitlines() if bare_lyric(ln) and not SECTION_LABEL.match(bare_lyric(ln))), "")
        print(f"  {song.get('title')}: {first[:80]}")
        if dry_run:
            n += 1
            continue
        header = [ln for ln in header if ln.startswith("{")]
        lp.write_text("\n".join(header) + "\n\n" + cleaned.lstrip("\n"), encoding="utf-8", newline="\n")
        form = draft_form(cleaned)
        if form:
            song["form"] = form
        elif "form" in song:
            del song["form"]
        write_json(song_path, song)
        man_path = song_path.parent / "sources" / "manifest.json"
        if man_path.exists():
            manifest = json.loads(man_path.read_text(encoding="utf-8"))
            row = next((f for f in manifest.get("files") or [] if f.get("file") == "lyrics.chordpro"), None)
            if row:
                row["sha256"] = sha256(lp)
                write_json(man_path, manifest)
        n += 1
    print(f"stripped {n} lyrics.chordpro files")
    return 0


def selftest() -> None:
    # the header layouts the site actually uses
    assert parse_written_by("", "Written by Elton Smith and Larry Holder\n\nRecording by Susan Tolle-Knight") == ["Elton Smith", "Larry Holder"]
    assert parse_written_by("", "Music by Mark Wilkinson, Words by Larry Holder.") == ["Mark Wilkinson", "Larry Holder"]
    assert parse_written_by("", "Words by Larry Holder\nand Rick Founds\nMusic by Rick Founds") == ["Larry Holder", "Rick Founds"]
    assert parse_written_by("", "Words by Elton Smith, Larry Holder, and Steve Israel") == ["Elton Smith", "Larry Holder", "Steve Israel"]
    assert writer_credit(["Elton Smith", "Larry Holder"]) == "Elton Smith / Larry Holder"
    # stage directions -> labels/cues; verbatim repeats -> Chorus; refrain glued to a source-labelled verse
    body = label_stanzas("(8 Measure Introduction)\n\n(Mary sings verse 1)\nA\nB\n\nR1\nR2\n\n(Bridge)\n(Elizabeth)\nC\n\nX\nY\n\n(Change keys)\n\nZ\n\nX\nY\n")
    assert body.split("\n\n") == ["Verse 1\n{c: Mary}\nA\nB\nR1\nR2", "Bridge\n{c: Elizabeth}\nC", "Chorus\nX\nY", "Verse 2\nZ", "Chorus\nX\nY\n"], body
    # <BR>-per-line pages: a stanza break is a doubled <BR>, the HTML's own newlines mean nothing
    html = '<div id="lyrics"><header><h2>Lyrics</h2></header><h3>\nA long enough lyric line one,<BR>\nline two of the song,<BR>\n<BR>\nline three of the song,<BR>\nand the fourth line here.<BR>\n</h3>Copyright &copy; 2000'
    assert lyrics_from_sop(html) == "Verse 1\nA long enough lyric line one,\nline two of the song,\n\nVerse 2\nline three of the song,\nand the fourth line here.\n"
    # chord chart: chords over fragments, &nbsp; keeps a space, "A-" + "bove" joins, intro dropped, repeat chorus refilled
    chart = ('<title>X (A) by L</title><table><tr><td class="chord">(INTRODUCTION)</td></tr></table>'
             '<table><tr><td class="chord">A&nbsp;&nbsp;</td><td class="chord">E&nbsp;&nbsp;</td></tr></table>'
             '<table><tr><td class="chord">(CHORUS)</td></tr></table>'
             '<table><tr><td class="chord">&nbsp;&nbsp;&nbsp;</td><td class="chord">A&nbsp;&nbsp;</td><td class="chord">F#m&nbsp;&nbsp;</td></tr>'
             '<tr><td>Praise to&nbsp;</td><td>You, God A-</td><td>bove,</td></tr></table>'
             '<table class="do_not_print_me"><tr><td>Modulate section:</td></tr></table>'
             '<table><tr><td class="chord">&nbsp;&nbsp;&nbsp;</td></tr><tr><td>(Repeat Chorus 2 times)</td></tr></table>'
             '<table><tr><td class="chord">(ENDING)</td></tr></table>'
             '<table><tr><td class="chord">Bm&nbsp;&nbsp;</td><td class="chord">A/C#&nbsp;&nbsp;</td></tr><tr><td>You Lord my&nbsp;</td><td>God</td></tr></table>')
    key, secs = parse_chord_chart(chart)
    assert key == "A", key
    assert secs[0] == ("Chorus", ["Praise to [A]You, God A-[F#m]bove,"]), secs
    assert secs[1:] == [("Chorus", ["Praise to [A]You, God A-[F#m]bove,"]), ("Ending", ["[Bm]You Lord my [A/C#]God"])], secs
    victory = strip_labeled_chrome(
        "Verse 1\n[Gm7]Inspired by Romans 8:38-39\nWords and Music by\nLawrence Keith Holder\n"
        "Copyright 1992 Lawrence Keith Holder\nOur Song of Victory\n"
        "1. The [Eb]Lord provides for me always,\nFor each and ev'ry care.\n\n"
        "Chorus\n[Cm]For I'm sure that neither death, nor life,\nWe have won!\n",
        "Our Song of Victory",
    )
    assert "Copyright" not in victory and "Inspired by" not in victory, victory
    assert victory.startswith("Verse 1\n1. The [Eb]Lord provides"), victory
    assert "Chorus\n[Cm]For I'm sure" in victory, victory
    still = strip_labeled_chrome(
        "Verse 1\nInspired by Psalm 46\n\nVerse 2\nLawrence Keith Holder\n\n"
        "Verse 3\nCopyright © 1998 Lawrence Keith Holder\n\n"
        "Verse 4\nand let me know what you think of this song or this method\nof outreach.\n\n"
        "Verse 5\n1. Be still and know that He is God:\nHe breaks the mighty bow,\n",
        "Be Still And Know",
    )
    assert still.startswith("Verse 1\n1. Be still and know"), still
    assert "Copyright" not in still and "outreach" not in still, still
    you_are = strip_labeled_chrome(
        "Verse 1\nChuck Brown\n\nVerse 2\nCopyright © 2003 Chuck Brown and Larry Holder\n\n"
        "Verse 3\n1. You, O Lord, are the Word of Life,\nPerfect are Your ways.\n\n"
        "Chorus:\nOur eyes longing to see You,\n",
        "You Are",
    )
    assert "Chuck Brown" not in you_are and "Copyright" not in you_are, you_are
    assert "1. You, O Lord, are the Word of Life," in you_are, you_are
    heart = (
        "Verse 1\n[A]All of my heart [F#m]here to love You,\nAnd [G]all of my soul [D]here to praise You,\n\n"
        "Chorus\nPraise to [A]You, God A-[F#m]bove,\n"
    )
    assert strip_labeled_chrome(heart, "All Of My Heart").strip() == heart.strip()
    child = "Verse 1\nMais que um menino,\nenvolto em palhas\nJesus meu Senhor,\n"
    assert strip_labeled_chrome(child, "Mais Que Um Menino").strip() == child.strip()
    print("selftest ok")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--refresh", action="store_true", help="rewrite lyrics/song.json/manifest of packages that already exist")
    ap.add_argument("--ccli", action="store_true", help="re-fetch source pages and stamp song.json ccli")
    ap.add_argument("--chords", action="store_true", help="merge the writer's chord chart into lyrics.chordpro")
    ap.add_argument("--strip-chrome", action="store_true", help="drop copyright/credit preamble from existing larry-holder lyrics")
    ap.add_argument("--only", help="--chords: restrict to packages whose folder name contains this")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return 0
    if args.ccli:
        return backfill_ccli(args.dry_run)
    if args.chords:
        return backfill_chords(args.dry_run, args.only)
    if args.strip_chrome:
        return strip_existing(args.dry_run)
    STAGING.mkdir(parents=True, exist_ok=True)

    urls = collect_song_urls()
    print(f"found {len(urls)} candidate pages")
    imported, skipped = [], []
    for url, theme in urls.items():
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
        if (dest / "song.json").exists() and not args.refresh:
            print(f"    have {dest.name}")
            imported.append(str(dest.relative_to(ROOT)))
            continue
        pkg = write_song(url, html, text, files, title, year, body, writer, theme)
        imported.append(str(pkg.relative_to(ROOT)))
        print(f"    -> {pkg.relative_to(ROOT)}")

    print(f"imported {len(imported)}, skipped {len(skipped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
