// Shared helpers for the WorshipCommonsContent tools. Plain Node ESM, zero dependencies.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// deterministic char(11) id in UniqueIdHelper.shortId's base64url format — must
// match idFor in WorshipCommonsApi/src/seed-data/catalog.ts. Ids are frozen in
// song.json at export time; this is only used to stamp NEW songs.
export const idFor = title => crypto.createHash("sha1").update("wcsong:" + title).digest("base64url").slice(0, 11);

// language name (as stored in song.json "language") → songs/<code>/ dir
export const LANG_CODES = {
  English: "en",
  German: "de",
  Spanish: "es",
  Latin: "la",
  French: "fr",
  Portuguese: "pt",
  Russian: "ru",
  Malayalam: "ml",
  Albanian: "sq",
  Hungarian: "hu",
  Zulu: "zu",
  Swedish: "sv"
};

// folder name from a title: lowercase, apostrophes dropped, other punctuation/space
// runs → "-", diacritics and non-Latin scripts kept. Cosmetic only — identity is song.json id.
export const slugify = title =>
  title.normalize("NFC").toLowerCase()
    .replace(/['’ʼ]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "untitled";

// Package folder = <slug>-<id>. The id is the identity and can begin with "-" or "_",
// so parse by the last 11 characters, never by splitting on the dash. The folder name is
// frozen at creation like the id: a title edit does not rename it (asset URLs are keys).
// The same path is used in git and in the content bucket, so sync is a plain copy.
export const packageFolder = (title, id) => `${slugify(title)}-${id}`;
export const idFromFolder = folder => (folder.length > 12 && folder[folder.length - 12] === "-") ? folder.slice(-11) : null;

// licenses/licenses.json is the registry of the six licenses we host; song.json "license" is one of its ids and
// the song lives under songs/<lang>/<registry.section>/. The site vendors this file as src/licenses.json.
export const LICENSES = Object.fromEntries(
  JSON.parse(fs.readFileSync(new URL("../licenses/licenses.json", import.meta.url), "utf8")).licenses.map(l => [l.id, l])
);
export const SECTIONS = Object.values(LICENSES).map(l => l.section);

// Package layout (vision/files.md): every file is in sources/, masters/, or derivatives/.
// Read helpers fall back to the pre-migration flat folder so tools still run mid-cutover.
export const songJsonPath = dir => {
  const neu = path.join(dir, "masters", "song.json");
  return fs.existsSync(neu) ? neu : path.join(dir, "song.json");
};
export const lyricsPath = dir => {
  const neu = path.join(dir, "masters", "lyrics.chordpro");
  return fs.existsSync(neu) ? neu : path.join(dir, "lyrics.chordpro");
};
export const workJsonPath = dir => {
  const neu = path.join(dir, "masters", "work.json");
  return fs.existsSync(neu) ? neu : path.join(dir, "work.json");
};
export const manifestPath = dir => path.join(dir, "sources", "manifest.json");
export const harvestedPath = dir => {
  const neu = path.join(dir, "sources", "hymnary.json");
  return fs.existsSync(neu) ? neu : path.join(dir, "sources", "harvested.json");
};
export const hymnaryPath = dir => path.join(dir, "sources", "hymnary.json");
export const videoPath = dir => path.join(dir, "sources", "video.json");
export const sourcesTxtPath = dir => {
  const neu = path.join(dir, "derivatives", "sources.txt");
  return fs.existsSync(neu) ? neu : path.join(dir, "sources.txt");
};

export const ensurePkgDirs = dir => {
  for (const d of ["sources", "masters", "derivatives"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
};

export const readSong = dir => readJson(songJsonPath(dir));
export const readHarvested = dir => {
  const out = {};
  const hymnary = path.join(dir, "sources", "hymnary.json");
  const legacy = path.join(dir, "sources", "harvested.json");
  if (fs.existsSync(hymnary)) Object.assign(out, readJson(hymnary));
  else if (fs.existsSync(legacy)) Object.assign(out, readJson(legacy));
  const video = path.join(dir, "sources", "video.json");
  if (fs.existsSync(video)) out.video = readJson(video);
  return out;
};

export function writeHarvested(dir, harvested) {
  const src = path.join(dir, "sources");
  fs.mkdirSync(src, { recursive: true });
  const hymnary = {};
  if (typeof harvested.hymnalCount === "number") hymnary.hymnalCount = harvested.hymnalCount;
  if (typeof harvested.churchCount === "number") hymnary.churchCount = harvested.churchCount;
  if (Object.keys(hymnary).length) writeJson(path.join(src, "hymnary.json"), hymnary);
  if (harvested.video?.youtube) writeJson(path.join(src, "video.json"), harvested.video);
  const legacy = path.join(src, "harvested.json");
  if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
}

export const SECTION_LABEL = /^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus|estrofa|coro|estribillo|strophe|kehrvers)\b/i;

export function licenseNotice(song) {
  const lic = LICENSES[song.license];
  if (!lic) return "";
  const vars = {
    year: String(song.year ?? ""),
    writer: song.writer ?? "",
    version: song.licenseVersion || lic.versionDefault,
    licenseUrl: song.licenseUrl || lic.deedUrl
  };
  let notice = lic.notice.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  if (song.attribution?.text) notice = `${song.attribution.text}${song.attribution.link ? ` — ${song.attribution.link}` : ""}. ${notice}`;
  return notice;
}

export function parseChordproStanzas(body) {
  const stanzas = [];
  let cur = null;
  const push = () => { if (cur && (cur.lines.length || cur.label)) stanzas.push(cur); cur = null; };
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const plain = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!line.trim()) { push(); continue; }
    if (SECTION_LABEL.test(plain) && !/\[[^\]]+\]/.test(line)) {
      push();
      cur = { label: plain, lines: [] };
      continue;
    }
    if (!cur) cur = { label: null, lines: [] };
    cur.lines.push(line);
  }
  push();
  return stanzas;
}

export function stripChords(line) {
  return line.replace(/\[[^\]]*\]/g, "").replace(/[ \t]+/g, " ").trim();
}

export function chordLyricPair(line) {
  let chords = "", lyrics = "", last = 0;
  const re = /\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(line))) {
    lyrics += line.slice(last, m.index);
    while (chords.length < lyrics.length) chords += " ";
    chords += m[1];
    if (!chords.endsWith(" ")) chords += " ";
    last = m.index + m[0].length;
  }
  lyrics += line.slice(last);
  return { chords: chords.trimEnd(), lyrics: lyrics.replace(/\s+$/, "") };
}

// Draft the form map from ChordPro section labels. No measures until a score exists.
export function draftForm(body) {
  const labels = [];
  for (const line of body.split("\n")) {
    const t = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!t || t.startsWith("{") || t.startsWith("#")) continue;
    if (SECTION_LABEL.test(t)) labels.push(t);
  }
  if (!labels.length) return undefined;
  const seen = new Map();
  const sections = [];
  let lyric = 0;
  for (const label of labels) {
    if (!seen.has(label)) {
      seen.set(label, ++lyric);
      sections.push({ label, lyric });
    }
  }
  // status "draft" until a person confirms the map (files.md §2.3); a reviewer sets "approved"
  return { status: "draft", sections, defaultOrder: labels };
}

// Generated covers are kept (decision 2026-09-07): no writer art exists anywhere in the
// catalog, and the existing covers are the approved package image, never regenerated.
export const GENERATED_COVER_RIGHTS = {
  license: "PD",
  basis: "worshipcommons",
  note: "Generated cover kept as the package's approved image; not regenerated"
};

// A PD claim resting on a post-1930 publication year needs a person to look.
export function pdReviewNote(song) {
  const y = Number(song.year);
  if (song.license !== "PD" || !Number.isFinite(y) || y <= 1930) return null;
  const src = song.rights?.text?.source ?? "the source";
  return `Published ${y}, after the US PD cutoff; PD claim rests on ${src}'s dedication — verify`;
}

export const sha256File = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export const isoDate = () => new Date().toISOString().slice(0, 10);

// No release versioning (decision 2026-09-08): git history is the record of masters/,
// a submission's change note becomes the export commit message, and derivatives are
// rebuilt in place.

// work-level files a member inherits unless it has its own copy
export const SHARED_RELS = ["sources/tune.mid", "sources/tune.abc", "masters/cover.webp", "masters/score.musicxml"];

// leftover files at the package root after the sources/masters/derivatives split
export const STRAY_ROOT_FILES = [
  "song.json", "lyrics.chordpro", "work.json",
  "tune.mid", "tune.abc", "sheetPdf.pdf", "timing.json",
  "art.webp", "art-thumb.webp", "cover.webp", "cover-thumb.webp", "sources.txt", "manifest.json", "harvested.json", "hymnary.json"
];

// resolve a package-relative file (e.g. "sources/tune.mid"), song override then work, with flat-folder fallback
export function resolveShared(rootRel, dir, work, rel, { inherit = true } = {}) {
  const name = rel.split("/").pop();
  const candidates = [
    { p: path.join(dir, rel), url: `${rootRel}/${rel}` },
    { p: path.join(dir, name), url: `${rootRel}/${name}` }
  ];
  if (inherit && work) {
    const workRel = `works/${work.folder}`;
    candidates.push(
      { p: path.join(work.dir, rel), url: `${workRel}/${rel}` },
      { p: path.join(work.dir, name), url: `${workRel}/${name}` }
    );
  }
  for (const c of candidates) {
    if (fs.existsSync(c.p)) return { path: c.p, url: c.url.replaceAll("\\", "/"), bytes: fs.statSync(c.p).size };
  }
  return { path: null, url: null, bytes: null };
}

const SONG_KEY_ORDER = [
  "id", "title", "writer", "writerRef", "year", "language", "themes",
  "key", "bpm", "timeSignature", "meter", "tune", "scripture", "scriptureText",
  "license", "licenseVersion", "licenseUrl", "licenseSource", "attribution",
  "rights", "form", "chart", "pipeline", "recommendedKey",
  "workRef", "relationLabel", "parent", "contributors", "uploads",
  "status", "submittedBy", "proAnswer", "certified"
];

export function orderSong(song) {
  const out = {};
  for (const k of SONG_KEY_ORDER) if (song[k] !== undefined) out[k] = song[k];
  for (const k of Object.keys(song)) if (!(k in out)) out[k] = song[k];
  return out;
}

export function deriveRights(song) {
  const lic = song.license;
  const version = song.licenseVersion || undefined;
  const layer = basis => {
    if (!basis) return null;
    const o = { license: lic, basis };
    if (version) o.version = version;
    return o;
  };
  const text = { license: lic, basis: song.year != null && song.year !== "" ? `published ${song.year}` : (song.licenseSource || song.provenance?.text || null) };
  if (version) text.version = version;
  if (song.licenseUrl) text.url = song.licenseUrl;
  if (song.provenance?.text) text.source = song.provenance.text;
  const arrangementBasis = song.provenance?.abc
    || (song.uploads?.sheetPdf ? (song.provenance?.tune || song.provenance?.text) : null);
  return {
    text,
    tune: layer(song.provenance?.tune || null),
    arrangement: layer(arrangementBasis),
    recording: null,
    artwork: song.provenance?.art && song.provenance.art !== "worshipcommons" ? layer(song.provenance.art) : null
  };
}

export function splitHarvested(song) {
  const harvested = {};
  if (typeof song.hymnalCount === "number") harvested.hymnalCount = song.hymnalCount;
  if (typeof song.churchCount === "number") harvested.churchCount = song.churchCount;
  if (song.video?.youtube) harvested.video = song.video;
  const masters = { ...song };
  delete masters.hymnalCount;
  delete masters.churchCount;
  delete masters.video;
  delete masters.provenance;
  if (masters.parent == null) delete masters.parent;
  if (masters.relationLabel == null) delete masters.relationLabel;
  if (masters.scriptureText == null) delete masters.scriptureText;
  if (!masters.rights) masters.rights = deriveRights(song);
  return { masters: orderSong(masters), harvested, provenance: song.provenance ?? {} };
}

const SHEET_SOURCES = new Set(["cmaa", "cmpilato", "mutopia"]);
const MANIFEST_BASIS = {
  "tune.mid": rowProv => rowProv.tune,
  "tune.abc": rowProv => rowProv.abc,
  // SATB letter PDFs in this catalog are Mutopia unless the song itself is a CMAA/Pilato/Mutopia import
  "sheetPdf.pdf": rowProv => SHEET_SOURCES.has(rowProv.text) ? rowProv.text : SHEET_SOURCES.has(rowProv.tune) ? rowProv.tune : "mutopia",
  "hymnary.json": () => "hymnary",
  "harvested.json": () => "hymnary",
  "video.json": () => "worshipcommons"
};

const MANIFEST_NOTE = {
  "tune.mid": "Existing catalog copy; original bytes not backfilled",
  "tune.abc": "Existing catalog copy; original bytes not backfilled",
  "sheetPdf.pdf": "Existing catalog copy",
  "hymnary.json": "Harvested hymnal counts and churchCount snapshot — merged at catalog build",
  "video.json": "YouTube performance id; a link, not an audio asset"
};

// Rewrites sources/manifest.json from what is on disk. Existing rows keep their
// url / acquired / basis / note unless an override is passed, so re-running never
// forgets where a file came from. `original` is true only when we hold the bytes as
// fetched (url + acquired known); false means "existing catalog copy" whose
// acquisition still has to be backfilled (files.md §1.6).
export function writeManifest(dir, provenance = {}, { urls = {}, notes = {}, basis = {}, acquired = {} } = {}) {
  const srcDir = path.join(dir, "sources");
  fs.mkdirSync(srcDir, { recursive: true });
  const mp = path.join(srcDir, "manifest.json");
  const prev = new Map((fs.existsSync(mp) ? readJson(mp).files ?? [] : []).map(r => [r.file, r]));
  const files = [];
  for (const name of fs.readdirSync(srcDir).sort()) {
    if (name === "manifest.json") continue;
    const p = path.join(srcDir, name);
    if (!fs.statSync(p).isFile()) continue;
    const old = prev.get(name) ?? {};
    const sha = sha256File(p);
    const same = old.sha256 === sha;
    const url = urls[name] ?? (same ? old.url : null) ?? null;
    const when = acquired[name] ?? (same ? old.acquired : null) ?? null;
    const licenseBasis = basis[name] ?? old.licenseBasis ?? MANIFEST_BASIS[name]?.(provenance) ?? provenance.text ?? "contributor";
    files.push({
      file: name,
      url,
      acquired: when,
      sha256: sha,
      licenseBasis,
      original: !!(url && when),
      submittedBy: old.submittedBy ?? null,
      note: notes[name] ?? (same ? old.note : null) ?? MANIFEST_NOTE[name] ?? null
    });
  }
  writeJson(mp, { files });
  return files;
}

// harvest importers: write a new song in the three-folder layout
export function writeNewSong(dir, { song, body, files = {}, urls = {} }) {
  ensurePkgDirs(dir);
  const { masters, harvested, provenance } = splitHarvested(song);
  const lyrics = body.startsWith("{") ? (body.endsWith("\n") ? body : body + "\n") : renderChordpro(masters, body);
  if (!masters.form) {
    const form = draftForm(splitChordpro(lyrics).body);
    if (form) masters.form = form;
  }
  writeJson(path.join(dir, "masters", "song.json"), orderSong(masters));
  fs.writeFileSync(path.join(dir, "masters", "lyrics.chordpro"), lyrics);
  for (const [name, src] of Object.entries(files)) {
    if (!src || !fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dir, "sources", name));
  }
  if (Object.keys(harvested).length) writeHarvested(dir, harvested);
  writeManifest(dir, provenance, { urls });
}

// lyrics.chordpro = directive header lines, one blank line, body verbatim, one trailing \n.
// The body must roundtrip byte-identical to the DB chordPro column.
export function splitChordpro(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  let i = 0;
  const header = {};
  while (i < lines.length && lines[i].startsWith("{")) {
    const m = lines[i].match(/^\{([^:}]+):\s*(.*)\}$/);
    if (m) header[m[1].trim()] = m[2];
    i++;
  }
  if (lines[i] === "") i++;
  return { header, body: lines.slice(i).join("\n") };
}

export function renderChordpro(song, body) {
  const lines = [];
  const d = (name, v) => { if (v !== null && v !== undefined && v !== "") lines.push(`{${name}: ${v}}`); };
  d("title", song.title);
  d("artist", song.writer);
  d("key", song.key);
  d("time", song.timeSignature);
  d("tempo", song.bpm);
  return lines.join("\n") + "\n\n" + body + "\n";
}

const SOURCE_FILE_LABELS = {
  "tune.mid": "Tune (tune.mid)",
  "tune.abc": "Engraving source (tune.abc)",
  "sheetPdf.pdf": "Sheet music (sheetPdf.pdf)"
};

// sources.txt is generated from the package + sources.json — never hand-edited.
export function renderSourcesTxt(dir, song, sources) {
  const lines = [
    `${song.title} — sources & attribution`,
    "Generated from sources/manifest.json and the repository's sources.json. Do not edit by hand.",
    ""
  ];
  const textKey = song.rights?.text?.source || song.licenseSource;
  if (textKey) {
    const s = sources[textKey];
    if (!s) throw new Error(`${song.title}: rights.text.source / licenseSource references unknown source "${textKey}"`);
    let line = `Text (lyrics.chordpro): ${s.name}`;
    if (s.url) line += ` — ${s.url}`;
    if (s.attribution?.required) line += ` (attribution required)`;
    lines.push(line);
  }
  const mp = manifestPath(dir);
  const manifest = fs.existsSync(mp) ? readJson(mp) : { files: [] };
  const seen = new Set();
  for (const row of manifest.files ?? []) {
    if (row.file === "harvested.json" || row.file === "hymnary.json" || row.file === "video.json") continue;
    seen.add(row.file);
    const s = row.licenseBasis && row.licenseBasis !== "contributor" ? sources[row.licenseBasis] : null;
    if (row.licenseBasis && row.licenseBasis !== "contributor" && !s)
      throw new Error(`${song.title}: manifest ${row.file} references unknown source "${row.licenseBasis}"`);
    let line = `${SOURCE_FILE_LABELS[row.file] ?? row.file}: ${s?.name ?? row.licenseBasis ?? "unknown"}`;
    if (s?.url) line += ` — ${s.url}`;
    if (s?.attribution?.required) line += ` (attribution required)`;
    lines.push(line);
  }
  // inherited work assets: rights still name the source even when the bytes live on the work
  for (const [file, key] of [["tune.mid", song.rights?.tune?.basis], ["tune.abc", song.rights?.arrangement?.basis]]) {
    if (seen.has(file) || !key || !sources[key]) continue;
    const s = sources[key];
    let line = `${SOURCE_FILE_LABELS[file]}: ${s.name}`;
    if (s.url) line += ` — ${s.url}`;
    if (s.attribution?.required) line += ` (attribution required)`;
    lines.push(line);
  }
  const harvested = readHarvested(dir);
  if (harvested.hymnalCount > 0) lines.push("Hymnal-count metadata: Hymnary.org — https://hymnary.org");
  const lic = LICENSES[song.license];
  if (!lic) throw new Error(`${song.title}: unknown license "${song.license}"`);
  const pdSource = song.license === "PD" && song.licenseSource ? sources[song.licenseSource] : null;
  if (song.license === "PD" && song.licenseSource && !pdSource) throw new Error(`${song.title}: licenseSource references unknown source "${song.licenseSource}"`);
  const version = song.licenseVersion || lic.versionDefault;
  lines.push("", song.license === "PD"
    ? `License: Public domain.${pdSource ? ` Public-domain source: ${pdSource.name}.` : ""} See licenses/public-domain.md at the repository root.`
    : song.license === "WC"
    ? `License: The WorshipCommons License, Version ${version}. See licenses/wc-license.md at the repository root.`
    : `License: Creative Commons ${lic.label} ${version} — ${song.licenseUrl || lic.legalUrl}. See licenses/${lic.section}.md at the repository root.`);
  if (song.attribution?.text) lines.push(`Attribution: ${song.attribution.text}${song.attribution.link ? ` — ${song.attribution.link}` : ""}`);
  return lines.join("\n") + "\n";
}

// walk <root>/songs/<lang>/<section>/<slug>/ folders; yields { section, langDir, dir, folder }
export function* songDirs(root) {
  const songsRoot = path.join(root, "songs");
  if (!fs.existsSync(songsRoot)) return;
  for (const langDir of fs.readdirSync(songsRoot).filter(d => fs.statSync(path.join(songsRoot, d)).isDirectory()).sort()) {
    for (const section of SECTIONS) {
      const sectionRoot = path.join(songsRoot, langDir, section);
      if (!fs.existsSync(sectionRoot)) continue;
      for (const folder of fs.readdirSync(sectionRoot).filter(d => fs.statSync(path.join(sectionRoot, d)).isDirectory()).sort()) {
        yield { section, langDir, folder, dir: path.join(sectionRoot, folder) };
      }
    }
  }
}

// read <root>/works/<slug>/work.json into a map by slug. A work groups a
// translation family: shared assets live in the work package; member songs
// point at it via song.json workRef and inherit any file they do not override.
export function readWorks(root) {
  const worksRoot = path.join(root, "works");
  const works = new Map();
  if (!fs.existsSync(worksRoot)) return works;
  for (const slug of fs.readdirSync(worksRoot).filter(d => fs.statSync(path.join(worksRoot, d)).isDirectory()).sort()) {
    const dir = path.join(worksRoot, slug);
    const p = workJsonPath(dir);
    if (!fs.existsSync(p)) continue;
    works.set(slug, { ...JSON.parse(fs.readFileSync(p, "utf8")), dir, folder: slug });
  }
  return works;
}

export const readJson = p => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
