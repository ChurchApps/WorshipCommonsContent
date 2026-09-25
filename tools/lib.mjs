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
  Swedish: "sv",
  Dutch: "nl",
  Italian: "it",
  Chinese: "zh",
  Afrikaans: "af",
  Maltese: "mt",
  Romanian: "ro",
  Slovak: "sk",
  Finnish: "fi"
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

// licenses/licenses.json is the registry of grants we host; song.json "license"
// is one of its ids (the six featured grants, or a custom writer grant).
// The site vendors this file as src/licenses.json.
export const LICENSES = Object.fromEntries(
  JSON.parse(fs.readFileSync(new URL("../licenses/licenses.json", import.meta.url), "utf8")).licenses.map(l => [l.id, l])
);

// Package layout. Two folders and one root file:
//
//   song.json              identity, rights, form — nothing rebuilds it
//   sources/               bytes this package cannot reproduce from its own other files
//   output/composition/    what generate.mjs rebuilds
//   output/audio/          what tools/pack/build.py rebuilds
//
// output/ is deletable by definition, which is why .gitignore is a plain **/output/.
// The license is NOT in the path: it is mutable metadata and the path is the bucket key.
export const ROOT_FILES = ["song.json"];
export const songJsonPath = dir => path.join(dir, "song.json");
export const manifestPath = dir => path.join(dir, "sources", "manifest.json");
export const hymnaryPath = dir => path.join(dir, "sources", "hymnary.json");
export const harvestedPath = dir => path.join(dir, "sources", "hymnary.json");
export const videoPath = dir => path.join(dir, "sources", "video.json");
export const analyticsPath = dir => path.join(dir, "sources", "analytics.json");
export const outPath = (dir, name) => path.join(dir, "output", "composition", name);
export const sourcesTxtPath = dir => outPath(dir, "sources.txt");

// The same logical file can be a source (someone gave it to us) or an output (we made
// it from a source). Source wins; validate errors when both exist.
const firstExisting = (dir, ...rels) => {
  for (const rel of rels) {
    const p = path.join(dir, ...rel.split("/"));
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, ...rels[0].split("/"));
};
export const lyricsPath = dir => firstExisting(dir, "sources/lyrics.chordpro", "output/composition/lyrics.chordpro");
export const scorePath = dir => firstExisting(dir, "sources/score.musicxml", "output/composition/score.musicxml");
// files that may legitimately live in either folder, checked by validate
export const EITHER_RELS = ["lyrics.chordpro", "score.musicxml"];

export const ensurePkgDirs = dir => {
  for (const d of ["sources", "output/composition"]) fs.mkdirSync(path.join(dir, ...d.split("/")), { recursive: true });
};

// song.json as the tools see it: a translation's file holds its overrides and the parent's
// INHERITED_FIELDS fill the gaps. readSongRaw is the file as written, for tools that rewrite it.
export const readSongRaw = dir => readJson(songJsonPath(dir));
export function readSong(dir) {
  const song = readSongRaw(dir);
  if (!song.parent?.id) return song;
  const parent = songIndex(path.resolve(dir, "..", "..", "..")).get(song.parent.id);
  if (!parent) return song;
  const base = readSongRaw(parent.dir);
  for (const k of INHERITED_FIELDS) if (song[k] === undefined && base[k] !== undefined) song[k] = base[k];
  return song;
}
export const readHarvested = dir => {
  const out = {};
  const hymnary = path.join(dir, "sources", "hymnary.json");
  const legacy = path.join(dir, "sources", "harvested.json");
  if (fs.existsSync(hymnary)) Object.assign(out, readJson(hymnary));
  else if (fs.existsSync(legacy)) Object.assign(out, readJson(legacy));
  const video = path.join(dir, "sources", "video.json");
  if (fs.existsSync(video)) out.video = readJson(video);
  const ccliFile = path.join(dir, "sources", "ccli.json");
  if (fs.existsSync(ccliFile)) {
    const rec = readJson(ccliFile);
    if (rec?.ccli) out.ccli = String(rec.ccli);
  }
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

// "Chorus3" counts too: the heading word may run straight into its number
export const SECTION_LABEL = /^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus|estrofa|coro|estribillo|strophe|kehrvers)(?:\b|(?=\d))/i;
const COMMENT_DIRECTIVE = /^\s*\{\s*(?:c|ci|comment|comment_italic)\s*:\s*(.+?)\s*\}\s*$/i;
// "Verse 1:" and "CHORUS: (2x)" name the same sections as "Verse 1" and "CHORUS (2x)"
const tidyLabel = label => label.replace(/:(?=\s|$)/g, "").replace(/\s+/g, " ").trim();

// A stanza label: a known heading ("Verse 2", "Chorus3", "Verse 1:"), a ChordPro comment ("{c: Intro}"), or, as
// writers often chart it, any chord-free line wholly in parentheses ("(Chorus x2)", "(Intro/Instrumental)") —
// labelled by the text inside, without a trailing colon. Null for a lyric. The API's DuplicateHelper.sectionLabel
// and the site's chordpro.ts sectionLabel apply the same rule.
export function sectionLabelOf(line) {
  const comment = line.match(COMMENT_DIRECTIVE);
  if (comment) return tidyLabel(comment[1]) || null;
  const plain = line.replace(/\[[^\]]*\]/g, "").trim();
  const paren = !/\[[^\]]+\]/.test(line) && plain.match(/^\((.+)\)$/);
  if (paren) return tidyLabel(paren[1]);
  return SECTION_LABEL.test(plain) ? tidyLabel(plain) : null;
}

// The copyright notice the writer publishes, verbatim (song.json `copyright`, one line per notice —
// a translation adds its own), else "© year writer". PD has none.
export function copyrightLines(song) {
  if (song.copyright) return song.copyright.split("\n").map(l => l.trim()).filter(Boolean);
  if (song.license === "PD") return [];
  return [`© ${song.year ? `${song.year} ` : ""}${song.writer ?? ""}`.trim()];
}

// What the license lets you do, from licenses.json `notice`: placeholders {version} {licenseUrl}.
export function licenseTerms(song) {
  const lic = LICENSES[song.license];
  if (!lic) return "";
  const vars = { version: song.licenseVersion || lic.versionDefault, licenseUrl: song.licenseUrl || lic.deedUrl };
  return lic.notice.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

// One line for a PDF footer: copyright, then terms.
export function licenseNotice(song) {
  return [...copyrightLines(song), licenseTerms(song)].filter(Boolean).join(". ").replace(/\.\. /g, ". ");
}

// attribution.txt — what a church puts under the lyrics: title, the copyright as the writer states it,
// any credit or source the license asks for that the copyright does not already say, then the terms.
export function attributionText(song) {
  const lines = [song.title];
  const copyright = copyrightLines(song);
  lines.push(...(copyright.length ? copyright : [`${song.writer ?? ""}${song.year ? `, ${song.year}` : ""}`]));
  const a = song.attribution ?? {};
  const credit = a.text && a.text !== song.writer && !copyright.some(l => l.includes(a.text)) ? a.text : "";
  const source = a.link && a.link !== song.licenseUrl ? a.link : "";
  if (credit || source) lines.push(credit && source ? `${credit} — ${source}` : credit || `Source: ${source}`);
  lines.push(licenseTerms(song));
  return lines.filter(Boolean).join("\n") + "\n";
}

export function parseChordproStanzas(body) {
  const stanzas = [];
  let cur = null;
  const push = () => {
    const prev = stanzas[stanzas.length - 1];
    // "(Bridge)" over a chord line, a blank line, then the bridge's words: the unlabelled block is that section's
    if (cur && !cur.label && prev?.label && prev.lines.every(l => !stripChords(l).trim())) prev.lines.push(...cur.lines);
    else if (cur && (cur.lines.length || cur.label)) stanzas.push(cur);
    cur = null;
  };
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { push(); continue; }
    const label = !/\[[^\]]+\]/.test(line) && sectionLabelOf(line);
    if (!label && /^\s*\{/.test(line)) continue; // {c: Mary} and other directives are cues, not lyrics (the site drops them too)
    if (label) {
      push();
      cur = { label, lines: [] };
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
    const label = sectionLabelOf(line);
    if (label) labels.push(label);
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

// A PD claim resting on a post-1930 publication year needs a person to look.
export function pdReviewNote(song) {
  const y = Number(song.year);
  if (song.license !== "PD" || !Number.isFinite(y) || y <= 1930) return null;
  const src = song.rights?.text?.source ?? "the source";
  return `Published ${y}, after the US PD cutoff; PD claim rests on ${src}'s dedication — verify`;
}

export const sha256File = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export const isoDate = () => new Date().toISOString().slice(0, 10);

// No release versioning (decision 2026-09-08): git history is the record of song.json + sources/,
// a submission's change note becomes the export commit message, and derivatives are
// rebuilt in place.

// Translations. A translation is a full song package whose song.json names its parent
// (`parent: { id }`, the base version — the original language when we have it). It owns its
// words, timings, translator credit, rights and status; anything it leaves out it inherits
// from the parent: the metadata in INHERITED_FIELDS and the files in SHARED_RELS, plus the
// parent's built audio (output/audio/) since the recording is the parent's. Families are
// flat: a parent is never itself a translation. `noInherit: ["output/audio", ...]` on the
// translation suppresses a parent asset it cannot use (different verse order, say).
// The words and timing.json are never shared. The generators do not follow the parent
// link: a translation's score, thumbnail, and rehearsal audio come only from files in
// that package. The catalog points abc, midi, cover, and the recording at the parent.
export const INHERITED_FIELDS = ["writerRef", "themes", "key", "bpm", "timeSignature", "meter", "tune"];
export const SHARED_RELS = ["sources/tune.mid", "sources/tune.abc", "sources/cover.webp"];

// resolve a package-relative file (e.g. "sources/tune.mid"), song override then parent, with flat-folder fallback.
// `parent` is a songIndex entry ({ dir, rootRel }) or null.
export function resolveShared(rootRel, dir, parent, rel, { inherit = true, noInherit = [] } = {}) {
  const name = rel.split("/").pop();
  const candidates = [
    { p: path.join(dir, rel), url: `${rootRel}/${rel}` },
    { p: path.join(dir, name), url: `${rootRel}/${name}` }
  ];
  if (inherit && parent && !noInherit.some(p => rel === p || rel.startsWith(p + "/"))) {
    candidates.push(
      { p: path.join(parent.dir, rel), url: `${parent.rootRel}/${rel}` },
      { p: path.join(parent.dir, name), url: `${parent.rootRel}/${name}` }
    );
  }
  for (const c of candidates) {
    if (fs.existsSync(c.p)) return { path: c.p, url: c.url.replaceAll("\\", "/"), bytes: fs.statSync(c.p).size };
  }
  return { path: null, url: null, bytes: null };
}

// id → { id, dir, rootRel, langDir, folder } for every package under <root>/songs, built once per root
const indexCache = new Map();
export function songIndex(root) {
  const key = path.resolve(root);
  if (!indexCache.has(key)) {
    const m = new Map();
    for (const e of songDirs(root)) {
      const id = idFromFolder(e.folder);
      if (id) m.set(id, { id, ...e, rootRel: `songs/${e.langDir}/${e.folder}` });
    }
    indexCache.set(key, m);
  }
  return indexCache.get(key);
}

// the parent package of a translation (song.json parent.id), or null for a base song
export const parentOf = (root, song) => (song.parent?.id && songIndex(root).get(song.parent.id)) || null;

const SONG_KEY_ORDER = [
  "id", "title", "writer", "writerRef", "year", "language", "themes",
  "key", "bpm", "timeSignature", "meter", "tune", "scripture", "scriptureText",
  "license", "licenseVersion", "licenseUrl", "licenseSource", "ccli", "copyright", "attribution",
  "rights", "form", "chart", "pipeline", "recommendedKey",
  "parent", "relationLabel", "noInherit", "contributors", "uploads",
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
  "ccli.json": () => "songselect",
  "video.json": () => "worshipcommons",
  "analytics.json": () => "worshipcommons",
  "ccli.json": () => "songselect",
  "lyrics.chordpro": rowProv => rowProv.text,
  "cover.webp": () => "worshipcommons",
  "timing.json": () => "worshipcommons"
};

const MANIFEST_NOTE = {
  "tune.mid": "Existing catalog copy; original bytes not backfilled",
  "tune.abc": "Existing catalog copy; original bytes not backfilled",
  "sheetPdf.pdf": "Existing catalog copy",
  "hymnary.json": "Harvested hymnal counts and churchCount snapshot — merged at catalog build",
  "ccli.json": "Harvested CCLI SongSelect id for the public-domain work; reporting is optional",
  "video.json": "YouTube performance id; a link, not an audio asset",
  "analytics.json": "Catalog audit notes and judgments; not a citable source",
  "ccli.json": "Harvested CCLI song id; presence does not require reporting",
  "lyrics.chordpro": "The words. Nothing in this repo rebuilds them",
  "cover.webp": "Generated once by WorshipCommons tooling; kept, never regenerated",
  "timing.json": "Lyric timings; the generator does not live in this repo"
};

// Every file under sources/, as a posix path relative to sources/ ("tune.mid",
// "master/song.wav"). Subfolders are the grant-era layout: grants/, master/, extra/.
export function sourceFiles(dir) {
  const srcDir = path.join(dir, "sources");
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(srcDir, rel) : srcDir;
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (childRel === "manifest.json") continue;
      const p = path.join(srcDir, childRel);
      if (fs.statSync(p).isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk("");
  return out;
}

// Rewrites sources/manifest.json from what is on disk. Existing rows keep their
// url / acquired / basis / note and every grant field (layer, license, evidence, …)
// unless an override is passed, so re-running never forgets where a file came from or
// what was granted. `original` is true only when we hold the bytes as fetched
// (url + acquired known); false means "existing catalog copy" whose acquisition still
// has to be backfilled (files.md §1.6).
export function writeManifest(dir, provenance = {}, { urls = {}, notes = {}, basis = {}, acquired = {} } = {}) {
  const srcDir = path.join(dir, "sources");
  fs.mkdirSync(srcDir, { recursive: true });
  const mp = path.join(srcDir, "manifest.json");
  const prev = new Map((fs.existsSync(mp) ? readJson(mp).files ?? [] : []).map(r => [r.file, r]));
  const files = [];
  for (const name of sourceFiles(dir)) {
    const p = path.join(srcDir, name);
    const old = prev.get(name) ?? {};
    const sha = sha256File(p);
    const same = old.sha256 === sha;
    const url = urls[name] ?? (same ? old.url : null) ?? null;
    const when = acquired[name] ?? (same ? old.acquired : null) ?? null;
    const licenseBasis = basis[name] ?? old.licenseBasis ?? MANIFEST_BASIS[name]?.(provenance) ?? provenance.text ?? "contributor";
    const row = {
      file: name,
      url,
      acquired: when,
      sha256: sha,
      licenseBasis,
      original: !!(url && when),
      submittedBy: old.submittedBy ?? null,
      note: notes[name] ?? (same ? old.note : null) ?? MANIFEST_NOTE[name] ?? null
    };
    // grant fields are asserted by a person, never derived — carry them through untouched
    for (const k of Object.keys(old)) if (!(k in row)) row[k] = old[k];
    files.push(row);
  }
  writeJson(mp, { files });
  return files;
}

// harvest importers: write a new song in the package layout (song.json at the root, lyrics in sources/)
export function writeNewSong(dir, { song, body, files = {}, urls = {} }) {
  ensurePkgDirs(dir);
  const { masters, harvested, provenance } = splitHarvested(song);
  const lyrics = body.startsWith("{") ? (body.endsWith("\n") ? body : body + "\n") : renderChordpro(masters, body);
  if (!masters.form) {
    const form = draftForm(splitChordpro(lyrics).body);
    if (form) masters.form = form;
  }
  writeJson(songJsonPath(dir), orderSong(masters));
  fs.writeFileSync(path.join(dir, "sources", "lyrics.chordpro"), lyrics);
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
  "sheetPdf.pdf": "Sheet music (sheetPdf.pdf)",
  "lyrics.chordpro": "Text (lyrics.chordpro)",
  "cover.webp": "Cover art (cover.webp)"
};

// internal bookkeeping, not a citable source
const NOT_CITED = new Set(["harvested.json", "hymnary.json", "video.json", "timing.json", "analytics.json", "ccli.json"]);

// sources.txt is generated from the package + sources.json — never hand-edited.
const manifestHas = (dir, file) => readManifest(dir).some(r => r.file === file);

// Public domain carries no legal credit condition: a source that asks for credit is a request,
// and a song that says it needs none (a mixed PD/CC-BY source) prints nothing.
const creditNote = (song, s) => !s?.attribution?.required ? ""
  : song.license !== "PD" ? " (attribution required)"
  : song.attribution?.required === false ? "" : " (credit requested)";

export function renderSourcesTxt(dir, song, sources) {
  const lines = [
    `${song.title} — sources & attribution`,
    "Generated from sources/manifest.json and the repository's sources.json. Do not edit by hand.",
    ""
  ];
  const textKey = song.rights?.text?.source || song.licenseSource;
  if (textKey && !(manifestHas(dir, "lyrics.chordpro"))) {
    const s = sources[textKey];
    if (!s) throw new Error(`${song.title}: rights.text.source / licenseSource references unknown source "${textKey}"`);
    let line = `Text (lyrics.chordpro): ${s.name}`;
    if (s.url) line += ` — ${s.url}`;
    line += creditNote(song, s);
    lines.push(line);
  }
  const mp = manifestPath(dir);
  const manifest = fs.existsSync(mp) ? readJson(mp) : { files: [] };
  const seen = new Set();
  for (const row of manifest.files ?? []) {
    if (NOT_CITED.has(row.file) || row.file.startsWith("grants/")) continue;
    seen.add(row.file);
    const s = row.licenseBasis && row.licenseBasis !== "contributor" ? sources[row.licenseBasis] : null;
    if (row.licenseBasis && row.licenseBasis !== "contributor" && !s)
      throw new Error(`${song.title}: manifest ${row.file} references unknown source "${row.licenseBasis}"`);
    let line = `${SOURCE_FILE_LABELS[row.file] ?? row.file}: ${s?.name ?? row.licenseBasis ?? "unknown"}`;
    if (s?.url) line += ` — ${s.url}`;
    line += creditNote(song, s);
    lines.push(line);
  }
  // inherited assets: rights still name the source even when the bytes live on the parent
  for (const [file, key] of [["tune.mid", song.rights?.tune?.basis], ["tune.abc", song.rights?.arrangement?.basis]]) {
    if (seen.has(file) || !key || !sources[key]) continue;
    const s = sources[key];
    let line = `${SOURCE_FILE_LABELS[file]}: ${s.name}`;
    if (s.url) line += ` — ${s.url}`;
    line += creditNote(song, s);
    lines.push(line);
  }
  const harvested = readHarvested(dir);
  if (harvested.hymnalCount > 0) lines.push("Hymnal-count metadata: Hymnary.org — https://hymnary.org");
  const ccli = song.ccli || harvested.ccli;
  if (ccli) lines.push(`CCLI song id: ${ccli} — https://songselect.ccli.com/songs/${ccli} (reporting optional)`);
  const lic = LICENSES[song.license];
  if (!lic) throw new Error(`${song.title}: unknown license "${song.license}"`);
  const pdSource = song.license === "PD" && song.licenseSource ? sources[song.licenseSource] : null;
  if (song.license === "PD" && song.licenseSource && !pdSource) throw new Error(`${song.title}: licenseSource references unknown source "${song.licenseSource}"`);
  const version = song.licenseVersion || lic.versionDefault;
  lines.push("", song.license === "PD"
    ? `License: Public domain.${pdSource ? ` Public-domain source: ${pdSource.name}.` : ""} See licenses/public-domain.md at the repository root.`
    : song.license === "WC"
    ? `License: The WorshipCommons License, Version ${version}. See licenses/wc-license.md at the repository root.`
    : lic.custom
    ? `License: ${lic.label} — ${song.licenseUrl || lic.legalUrl}.`
    : `License: Creative Commons ${lic.label} ${version} — ${song.licenseUrl || lic.legalUrl}. See licenses/${lic.section}.md at the repository root.`);
  if (song.attribution?.text) lines.push(`Attribution: ${song.attribution.text}${song.attribution.link ? ` — ${song.attribution.link}` : ""}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Grants. A song has two independent rights layers: the composition (required —
// no grant, no song) and the master recording (optional — it adds multitracks).
// song.json rights.<layer> says what license each layer carries; the manifest row
// for each source file says who granted it, when, how, and where the paper is.
// See .notes/song-pipeline.md.
// ---------------------------------------------------------------------------
export const GRANT_LAYERS = ["text", "tune", "arrangement", "recording", "artwork", "extra", "grant"];
export const OBTAINED_VIA = ["upload-form", "email", "harvest", "transcription", "public-domain", "generated"];
const AUDIO_EXT = new Set([".wav", ".flac", ".m4a", ".mp3", ".aiff", ".aif", ".ogg", ".opus", ".mp4", ".mov"]);

export const readManifest = dir => {
  const mp = manifestPath(dir);
  return fs.existsSync(mp) ? (readJson(mp).files ?? []) : [];
};

// The granted master recording, if there is one. A YouTube id in sources/master/video.json
// is a link, not a master — it never yields stems or a pack.
export function masterAudio(dir) {
  const rel = sourceFiles(dir).find(f => f.startsWith("master/") && AUDIO_EXT.has(path.extname(f).toLowerCase()));
  return rel ? { rel, path: path.join(dir, "sources", rel) } : null;
}

const LAYER_LABEL = { text: "Words", tune: "Music", arrangement: "Arrangement", recording: "Recording", artwork: "Artwork" };
const COMPOSITION = ["text", "tune", "arrangement"];

// One row per granted layer, collapsing the composition layers when they agree.
export function grantRows(dir, song) {
  const rights = song.rights ?? {};
  const manifest = readManifest(dir);
  const grantOf = layer => manifest.find(r => r.layer === layer && (r.submittedBy || r.acquired || r.evidence)) ?? null;
  const rowFor = (label, layer, r) => {
    const lic = LICENSES[r.license ?? song.license];
    if (!lic) return null;
    const g = grantOf(layer);
    return {
      label,
      license: lic,
      version: r.version || ((r.license ?? song.license) === song.license ? (song.licenseVersion || lic.versionDefault) : lic.versionDefault),
      grantedBy: g?.submittedBy ?? null,
      grantedAt: g?.acquired ?? null,
      basis: r.basis ?? null
    };
  };
  const out = [];
  const comp = COMPOSITION.map(l => rights[l]).filter(Boolean);
  const oneComposition = comp.length && comp.every(r => (r.license ?? song.license) === (comp[0].license ?? song.license));
  if (oneComposition) {
    const row = rowFor("Composition", COMPOSITION.find(l => rights[l]), comp[0]);
    if (row) out.push(row);
  } else {
    for (const l of COMPOSITION) if (rights[l]) { const row = rowFor(LAYER_LABEL[l], l, rights[l]); if (row) out.push(row); }
  }
  for (const l of ["recording", "artwork"]) if (rights[l]) { const row = rowFor(LAYER_LABEL[l], l, rights[l]); if (row) out.push(row); }
  return out;
}

// LICENSE.txt travels inside every bundle we hand out: what was granted, by whom,
// what a church may do with it, and which files it was built from. Generated.
export function renderLicenseTxt(dir, song, sources) {
  const lines = [song.title];
  const by = [song.writer, song.year && `(${song.year})`].filter(Boolean).join(" ");
  if (by) lines.push(by);
  lines.push("");

  const rows = grantRows(dir, song);
  const w = Math.max(0, ...rows.map(r => r.label.length));
  for (const r of rows) {
    const who = [r.grantedBy, r.grantedAt].filter(Boolean).join(", ");
    const terms = r.license.id === "PD" ? "Public domain" : `${r.license.label} ${r.version}`;
    lines.push(`${r.label.padEnd(w)}  ${terms}${who ? `   granted by ${who}` : r.basis ? `   ${r.basis}` : ""}`);
  }
  if (rows.length) lines.push("");

  const lic = LICENSES[song.license];
  if (!lic) throw new Error(`${song.title}: unknown license "${song.license}"`);
  const wrap = (head, items) => {
    if (!items?.length) return;
    lines.push(`${head.padEnd(13)}${items[0].charAt(0).toLowerCase()}${items[0].slice(1)}`);
    for (const it of items.slice(1)) lines.push(`${" ".repeat(13)}${it.charAt(0).toLowerCase()}${it.slice(1)}`);
  };
  wrap("You may:", lic.may);
  wrap("You may not:", lic.mayNot);
  wrap("You must:", lic.must);

  // harvested metadata is not part of the bundle — same exclusions as sources.txt
  const built = readManifest(dir).filter(r =>
    r.layer !== "grant" && !r.file.startsWith("grants/") && !NOT_CITED.has(r.file));
  if (built.length) {
    lines.push("", "Built from:");
    const fw = Math.max(...built.map(r => r.file.length));
    for (const r of built) {
      const s = r.licenseBasis && r.licenseBasis !== "contributor" ? sources[r.licenseBasis] : null;
      const bits = [r.note || s?.name || r.licenseBasis].filter(Boolean);
      if (r.evidence) bits.push(`grant on file${r.acquired ? ` ${r.acquired}` : ""}`);
      else if (r.url) bits.push(r.url);
      lines.push(`  ${r.file.padEnd(fw)}   ${bits.join("; ")}`.trimEnd());
    }
    lines.push("  everything else in this bundle was generated by WorshipCommons from the files above");
  }

  const copyright = copyrightLines(song);
  if (copyright.length) lines.push("", ...copyright);
  if (song.attribution?.link && song.attribution.link !== song.licenseUrl) lines.push(`Source: ${song.attribution.link}`);
  lines.push("", `Full terms: ${song.licenseUrl || lic.legalUrl || lic.deedUrl}`);
  return lines.join("\n") + "\n";
}

// walk <root>/songs/<lang>/<slug>-<id>/ folders; yields { langDir, folder, dir }
export function* songDirs(root) {
  const songsRoot = path.join(root, "songs");
  if (!fs.existsSync(songsRoot)) return;
  for (const langDir of fs.readdirSync(songsRoot).filter(d => fs.statSync(path.join(songsRoot, d)).isDirectory()).sort()) {
    const langRoot = path.join(songsRoot, langDir);
    for (const folder of fs.readdirSync(langRoot).filter(d => fs.statSync(path.join(langRoot, d)).isDirectory()).sort()) {
      yield { langDir, folder, dir: path.join(langRoot, folder) };
    }
  }
}

export const readJson = p => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
