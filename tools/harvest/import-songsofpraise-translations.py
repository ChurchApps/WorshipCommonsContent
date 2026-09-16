"""Harvest translations of our Larry Holder songs from songsofpraise.org (Elton Smith).

Elton Smith confirmed (2026-09-16) that the translations of Larry Holder / Elton Smith songs
hosted on songsofpraise.org are available under Larry's non-profit grant. Each translation
becomes a song package of its own, linked to the library's English original with
`parent: { id }` (translator credit, words, its own recording when the site has one; tune,
key and tempo inherited). Only songs already in the library under `larry-holder` are
considered, so nothing enters without the composition grant.

  python tools/harvest/import-songsofpraise-translations.py [--dry-run] [--only <slug>]
"""
from __future__ import annotations

import argparse
import html as htmlmod
import importlib.util
import json
import re
from pathlib import Path
from urllib.parse import urljoin, quote

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
_spec = importlib.util.spec_from_file_location("lh", HERE / "import-larry-holder.py")
lh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lh)

BASE = "https://songsofpraise.org/"
SOURCE = "songs-of-praise"
GRANT = "grants/larry-holder-permissions.txt"
GRANT_TEXT = lh.GRANT_TEXT + """
Translations hosted on songsofpraise.org (Elton Smith): on 2026-09-16 Elton Smith confirmed
to WorshipCommons that the translations of Larry Holder / Elton Smith songs on his site are
available under these same terms. Translator credit stays on every copy.
"""
# site language label -> song.json language name (tools/lib.mjs LANG_CODES)
LANG_NAMES = {
    "Afrikaans": "Afrikaans", "Chinese": "Chinese", "Dutch/Flemish": "Dutch", "French": "French",
    "German": "German", "Italian": "Italian", "Maltese": "Maltese", "Portuguese": "Portuguese",
    "Romanian": "Romanian", "Russian": "Russian", "Slovak": "Slovak", "Spanish": "Spanish",
    "Finnish": "Finnish", "Swedish": "Swedish", "Hungarian": "Hungarian", "Zulu": "Zulu",
}
norm = lambda s: re.sub(r"[^a-z0-9]+", " ", htmlmod.unescape(s).casefold()).strip()


def text_of(html: str) -> str:
    return re.sub(r"\s+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", " ", html)))


def our_larry_songs() -> dict[str, tuple[Path, dict]]:
    out = {}
    for p in (ROOT / "songs").glob("*/*/song.json"):
        raw = p.read_text(encoding="utf-8")
        if "larry-holder" not in raw:
            continue
        s = json.loads(raw)
        if s.get("parent"):
            continue
        out[norm(s["title"])] = (p.parent, s)
    return out


def site_index() -> dict[str, str]:
    html = lh.fetch_text(BASE + "songsearch.php")
    return {norm(re.sub(r"<[^>]+>", "", n)): sid for sid, n in re.findall(r'href="/?song\.php\?songid=(\d+)"[^>]*>(.*?)</a>', html, re.I | re.S)}


def language_links(html: str) -> list[tuple[str, str]]:
    m = re.search(r"Languages for this song:(.*?)</p>", html, re.S)
    if not m:
        return []
    return [(u, lab.strip(" ,")) for u, lab in re.findall(r'href="([^"]+)"[^>]*>([^<]+)', m.group(1))]


def files_of(html: str) -> dict:
    # the site links some files with raw accented characters; http.client wants ASCII
    links = sorted({quote(htmlmod.unescape(u), safe="/:%?=&") for u in re.findall(r'href="([^"]+\.(?:mp3|mid|pdf))"', html, re.I)})
    mp3s = [u for u in links if u.lower().endswith(".mp3")]
    vocal = [u for u in mp3s if not re.search(r"_acc\.mp3$", u, re.I)]
    return {
        "mp3": urljoin(BASE, vocal[-1]) if vocal else None,  # the newest recording is listed last
        "extra": [urljoin(BASE, u) for u in mp3s if not vocal or u != vocal[-1]],  # older takes and accompaniment tracks
        "pdf": next((urljoin(BASE, u) for u in links if u.lower().endswith(".pdf")), None),
    }


def translator_of(page_text: str, parent_writer: str) -> tuple[str | None, int | None]:
    """Names in "Written by …" that are not the original writers, plus the translation's year."""
    m = re.search(r"Written by (.+?)(?: Links to contributors| See Comments| Accompaniment| Your browser)", page_text)
    names = re.split(r"\s*(?:,|&| and | y | e | en | et )\s*", m.group(1)) if m else []
    originals = {norm(n) for n in re.split(r"\s*(?:,|&| and |·)\s*", parent_writer)} | {"larry holder", "elton smith", "lawrence keith holder"}
    tr = [n.strip(" .") for n in names if n.strip(" .") and norm(n) not in originals]
    if not tr:
        m = re.search(r"Translat(?:ion|ed)(?: by| to \w+ by)?\s*:?\s*([A-Z][^.,]+?)(?:\.|,| -| and )", page_text)
        if m:
            tr = [m.group(1).strip()]
    y = re.search(r"(?:Tradu\w+|Translation|Vertaling|Traduzione|Übersetzung|Перевод)\s*(?:©|\(c\))?\s*(\d{4})", page_text, re.I)
    return (", ".join(tr) or None, int(y.group(1)) if y else None)


def import_translation(parent_dir: Path, parent: dict, url: str, lang_label: str, dry: bool) -> str:
    lang_name = LANG_NAMES.get(lang_label)
    if not lang_name:
        return f"skip {url}: unknown language {lang_label}"
    code = lh.LANG_CODES.get(lang_name)
    if not code:
        return f"skip {url}: no songs/<code> for {lang_name} — add it to tools/lib.mjs LANG_CODES"
    html = lh.fetch_text(url)
    title = htmlmod.unescape(re.sub(r"^Songs of Praise:\s*", "", re.search(r"<title>(.*?)</title>", html, re.S).group(1))).strip()
    if not re.search(r"[A-Za-z]", title):
        title = title.replace(" ", "")  # the site spaces out CJK characters
    body = lh.lyrics_from_sop(html)
    if not body:
        return f"skip {title}: no lyrics"
    page = text_of(html)
    translator, tr_year = translator_of(page, parent["writer"])
    sid = lh.id_for(title)
    pkg = ROOT / "songs" / code / f"{lh.slugify(title)}-{sid}"
    if dry:
        return f"would write {pkg.relative_to(ROOT)}  ({lang_name}; tr. {translator}; mp3={'yes' if files_of(html)['mp3'] else 'no'})"

    src = pkg / "sources"
    (src / "grants").mkdir(parents=True, exist_ok=True)
    (src / GRANT).write_text(GRANT_TEXT, encoding="utf-8", newline="\n")
    writer = f"{parent['writer']} · tr. {translator}" if translator else parent["writer"]
    lyrics = "\n".join([
        f"{{title: {title}}}", f"{{artist: {writer}}}",
        *([f"{{key: {parent['key']}}}"] if parent.get("key") else []),
        f"{{time: {parent.get('timeSignature', '4/4')}}}", f"{{tempo: {parent.get('bpm', 80)}}}",
        "", body.rstrip(), "",
    ])
    (src / "lyrics.chordpro").write_text(lyrics, encoding="utf-8", newline="\n")
    row = lambda file, u, layer, original, **kw: {
        "file": file, "url": u, "acquired": lh.ACQUIRED, "sha256": lh.sha256(src / file), "license": "larry-holder",
        "licenseBasis": SOURCE, "original": original, "submittedBy": "Elton Smith", "layer": layer,
        "obtainedVia": "harvest", "evidence": GRANT, **kw,
    }
    manifest = [row(GRANT, lh.LICENSE_URL, "grant", True), row("lyrics.chordpro", url, "text", False)]
    files = files_of(html)
    uploads, recording = {}, None
    if files["mp3"]:
        dest = src / "master" / "song.mp3"
        lh.download(files["mp3"], dest)
        manifest.append(row("master/song.mp3", files["mp3"], "recording", True))
        uploads["demoAudio"] = "song.mp3"
        recording = {"license": "larry-holder", "basis": "recording posted for free download on songsofpraise.org; non-profit grant", "source": SOURCE}
    for u in files["extra"]:
        name = u.rsplit("/", 1)[-1]
        lh.download(u, src / "extra" / name)
        manifest.append(row(f"extra/{name}", u, "recording", True, note="Granted alongside the song; kept as-is, not processed"))
    if files["pdf"]:
        lh.download(files["pdf"], src / "sheetPdf.pdf")
        manifest.append(row("sheetPdf.pdf", files["pdf"], "arrangement", True))
        uploads["sheetPdf"] = "sheetPdf.pdf"

    song = {
        "id": sid,
        "title": title,
        "writer": writer,
        "year": tr_year or parent.get("year"),
        "language": lang_name,
        "license": "larry-holder",
        "licenseVersion": "permissions",
        "licenseUrl": lh.LICENSE_URL,
        "attribution": {"required": True, "text": writer, "link": "https://larryholdermusic.org/copyright.html"},
        "rights": {
            "text": {"license": "larry-holder", "basis": f"translation published on songsofpraise.org{f'; tr. {translator}' if translator else ''}", "source": SOURCE, "url": lh.LICENSE_URL},
            "translation": {"license": "larry-holder", "basis": SOURCE, "holder": translator} if translator else None,
            "tune": None, "arrangement": None,
            "recording": recording,
            "artwork": None,
        },
        "form": lh.draft_form(body),
        "parent": {"id": parent["id"]},
        "relationLabel": f"{lang_name} translation" + (f" · tr. {translator}" if translator else "") + (f", {tr_year}" if tr_year else ""),
        "uploads": uploads or None,
    }
    for k in ("form", "uploads"):
        if song[k] is None:
            del song[k]
    lh.write_json(pkg / "song.json", song)
    lh.write_json(src / "manifest.json", {"files": manifest})
    return f"wrote {pkg.relative_to(ROOT)}"


def lang_codes() -> dict[str, str]:
    m = re.search(r"export const LANG_CODES = \{(.*?)\};", (ROOT / "tools" / "lib.mjs").read_text(encoding="utf-8"), re.S)
    return dict(re.findall(r'(\w+):\s*"(\w+)"', m.group(1)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only")
    a = ap.parse_args()
    lh.LANG_CODES = lang_codes()
    ours = our_larry_songs()
    index = site_index()
    done = skipped = 0
    for key, (pdir, parent) in sorted(ours.items()):
        if a.only and a.only not in pdir.name:
            continue
        sid = index.get(key)
        if not sid:
            continue
        html = lh.fetch_text(f"{BASE}song.php?songid={sid}")
        for u, label in language_links(html):
            if label == "English" or u.endswith(f"songid={sid}"):
                continue
            msg = import_translation(pdir, parent, urljoin(BASE, u), label, a.dry_run)
            print(f"{parent['title']} -> {msg}")
            if msg.startswith("skip"):
                skipped += 1
            else:
                done += 1
    print(f"{done} translations {'found' if a.dry_run else 'written'}, {skipped} skipped. Next: node tools/generate.mjs && node tools/build-catalog.mjs && node tools/validate.mjs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
