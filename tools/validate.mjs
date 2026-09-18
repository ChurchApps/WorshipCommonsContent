// Library sanity checks. Exit 1 on errors, prints warnings otherwise.
// Usage: node tools/validate.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  idFor, LANG_CODES, LICENSES, splitChordpro, renderSourcesTxt, songDirs, readJson,
  readSong, readSongRaw, parentOf, lyricsPath, sourcesTxtPath, manifestPath,
  SHARED_RELS, INHERITED_FIELDS, ROOT_FILES, EITHER_RELS, sha256File, idFromFolder,
  sourceFiles, masterAudio, GRANT_LAYERS, OBTAINED_VIA
} from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = readJson(path.join(ROOT, "sources.json"));
const THEMES = new Set(readJson(path.join(ROOT, "themes.json")).themes);
const errors = [];
const warnings = [];

// Only song.json lives at the package root; everything else is a source or an output.
function checkRoot(dir, label) {
  for (const name of fs.readdirSync(dir)) {
    if (ROOT_FILES.includes(name)) continue;
    if (["sources", "output"].includes(name) && fs.statSync(path.join(dir, name)).isDirectory()) continue;
    errors.push(`${label}: ${name} at the package root — it is either a source or an output`);
  }
}

// A file is given to us or built by us, never both: two owners means one is silently stale.
function checkOneOwner(dir, label) {
  for (const rel of EITHER_RELS) {
    if (fs.existsSync(path.join(dir, "sources", rel)) && fs.existsSync(path.join(dir, "output", "composition", rel)))
      errors.push(`${label}: ${rel} exists in both sources/ and output/composition/ — the source wins, delete the other`);
  }
}

const ids = new Map(); // id → dir
const parentIdOf = new Map(); // id → parent id (translations)
const licenseOf = new Map(); // id → license code
const foldersSeen = new Map(); // lang → Set of lowercased folder names
const langCodes = new Set(Object.values(LANG_CODES));
const REQUIRED = ["id", "title", "writer", "language", "license", "timeSignature", "rights"];
const METER_RE = /^(?:\d{1,2}(?:\.\d{1,2})+(?:[ .]D)?|[CLS]MD?)$/;
const REQUIRED_SUBMITTED = ["id", "title", "language", "license", "status"];

for (const { langDir, folder, dir } of songDirs(ROOT)) {
  const label = `songs/${langDir}/${folder}`;
  let song;
  try { song = readSong(dir); }
  catch (e) { errors.push(`${label}: unreadable song.json — ${e.message}`); continue; }
  const submitted = !!song.submittedBy;

  for (const f of submitted ? REQUIRED_SUBMITTED : REQUIRED) if (song[f] === undefined) errors.push(`${label}: song.json missing "${f}"`);
  if (song.id && !/^[A-Za-z0-9_-]{11}$/.test(song.id)) errors.push(`${label}: id "${song.id}" is not an 11-char base64url id`);
  if (song.id && ids.has(song.id)) errors.push(`${label}: duplicate id ${song.id} (also ${ids.get(song.id)})`);
  ids.set(song.id, label);
  // folder is <slug>-<id>: the same key in git and in the bucket
  if (song.id && idFromFolder(folder) !== song.id) errors.push(`${label}: folder must end with "-${song.id}"`);
  if (!langCodes.has(langDir)) errors.push(`${label}: unknown language dir "${langDir}"`);
  if (song.language && LANG_CODES[song.language] && LANG_CODES[song.language] !== langDir)
    errors.push(`${label}: language "${song.language}" belongs in ${LANG_CODES[song.language]}/, not ${langDir}/`);
  for (const th of String(song.themes ?? "").split(",").map(t => t.trim()).filter(Boolean))
    if (!THEMES.has(th)) errors.push(`${label}: theme "${th}" is not in themes.json`);
  const lic = LICENSES[song.license];
  if (!lic) errors.push(`${label}: unknown license "${song.license}" — must be one of ${Object.keys(LICENSES).join(", ")}`);
  if (lic?.attributionRequired && !song.licenseUrl) errors.push(`${label}: ${song.license} songs need "licenseUrl" (the exact license the writer applied)`);
  if (song.ccli != null && song.ccli !== "" && !/^\d{4,8}$/.test(String(song.ccli))) errors.push(`${label}: ccli "${song.ccli}" is not a 4–8 digit song id`);
  const ccliFile = path.join(dir, "sources", "ccli.json");
  if (fs.existsSync(ccliFile)) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(ccliFile, "utf8")); }
    catch (e) { errors.push(`${label}: sources/ccli.json is not JSON — ${e.message}`); rec = null; }
    if (rec) {
      if (!/^\d{4,8}$/.test(String(rec.ccli || ""))) errors.push(`${label}: sources/ccli.json ccli "${rec.ccli}" is not a 4–8 digit song id`);
      if (song.ccli && rec.ccli && String(song.ccli) !== String(rec.ccli)) errors.push(`${label}: song.json ccli ${song.ccli} != sources/ccli.json ${rec.ccli}`);
    }
  }
  if (lic?.attributionRequired && !song.attribution?.text && !submitted) errors.push(`${label}: ${song.license} songs need "attribution.text" (who to credit)`);
  licenseOf.set(song.id, song.license);
  if (song.meter !== undefined && song.meter !== null && !METER_RE.test(song.meter))
    errors.push(`${label}: meter "${song.meter}" is not a recognized meter (8.7.8.7, 8.7.8.7 D, CM, LM, SM, CMD)`);
  if (song.licenseSource) {
    if (!sources[song.licenseSource]) errors.push(`${label}: licenseSource references unknown source "${song.licenseSource}"`);
    if (song.license !== "PD") errors.push(`${label}: licenseSource is only valid for public-domain songs`);
  }
  if (song.rights && song.rights.text?.license && song.rights.text.license !== song.license)
    errors.push(`${label}: rights.text.license "${song.rights.text.license}" != license "${song.license}"`);
  if (song.hymnalCount !== undefined || song.churchCount !== undefined || song.video || song.provenance)
    errors.push(`${label}: harvested fields (hymnalCount/churchCount/video/provenance) belong in sources/, not song.json`);

  if (!foldersSeen.has(langDir)) foldersSeen.set(langDir, new Set());
  const lower = folder.toLowerCase();
  if (foldersSeen.get(langDir).has(lower)) errors.push(`${label}: folder name collides case-insensitively with a sibling`);
  foldersSeen.get(langDir).add(lower);

  checkRoot(dir, label);
  checkOneOwner(dir, label);

  if (song.workRef) errors.push(`${label}: "workRef" is gone — translations name their parent song (parent: { id })`);
  if (song.parent?.id) parentIdOf.set(song.id, song.parent.id);
  const parent = parentOf(ROOT, song);
  if (parent) {
    if (parent.id === song.id) errors.push(`${label}: is its own parent`);
    // a translation inherits what it does not override: a copy identical to the parent's is noise
    const raw = readSongRaw(dir), base = readSongRaw(parent.dir);
    for (const k of INHERITED_FIELDS)
      if (raw[k] !== undefined && JSON.stringify(raw[k]) === JSON.stringify(base[k]))
        warnings.push(`${label}: "${k}" equals the parent's — delete it to inherit`);
    for (const rel of SHARED_RELS) {
      const sp = path.join(dir, rel), pp = path.join(parent.dir, rel);
      if (fs.existsSync(sp) && fs.existsSync(pp) && fs.readFileSync(sp).equals(fs.readFileSync(pp)))
        errors.push(`${label}: ${rel} is byte-identical to the parent's — delete the copy to inherit`);
    }
    for (const rel of song.noInherit ?? [])
      if (!fs.existsSync(path.join(parent.dir, rel))) warnings.push(`${label}: noInherit "${rel}" names nothing the parent has`);
  }

  const cpPath = lyricsPath(dir);
  if (!fs.existsSync(cpPath)) { errors.push(`${label}: no lyrics.chordpro in sources/ or output/composition/`); continue; }
  const { header, body } = splitChordpro(fs.readFileSync(cpPath, "utf8"));
  if (!body.trim()) errors.push(`${label}: lyrics.chordpro has an empty body`);
  {
    // a harvest that kept the source page's chrome or its <br> double-spacing renders as one-line slides
    const ls = body.split("\n"), blank = ls.filter(l => !l.trim()).length;
    if (ls.length > 8 && blank / ls.length > 0.34) warnings.push(`${label}: lyrics.chordpro is mostly blank lines (${blank}/${ls.length}) — double-spaced harvest?`);
    const chrome = ls.find(l => /^\s*>/.test(l) || /^\s*\(?(introduction|instrumental|change keys?)\)?\s*$/i.test(l));
    if (chrome) warnings.push(`${label}: lyrics.chordpro has a non-lyric line "${chrome.trim()}"`);
  }
  const expect = { title: song.title, artist: song.writer, key: song.key, time: song.timeSignature, tempo: song.bpm };
  for (const [k, v] of Object.entries(expect)) {
    if (v === null || v === undefined) continue;
    if (header[k] === undefined) warnings.push(`${label}: lyrics.chordpro missing {${k}} directive`);
    else if (String(header[k]) !== String(v)) errors.push(`${label}: {${k}} directive "${header[k]}" != song.json "${v}"`);
  }

  if (submitted) continue;

  const mp = manifestPath(dir);
  if (!fs.existsSync(mp)) errors.push(`${label}: missing sources/manifest.json`);
  else {
    const manifest = readJson(mp);
    const listed = new Set();
    for (const row of manifest.files ?? []) {
      listed.add(row.file);
      const fp = path.join(dir, "sources", row.file);
      if (!fs.existsSync(fp)) errors.push(`${label}: manifest lists ${row.file} but sources/${row.file} is missing`);
      else if (row.sha256 && row.sha256 !== sha256File(fp)) errors.push(`${label}: manifest sha256 for ${row.file} is stale`);
      if (row.licenseBasis && row.licenseBasis !== "contributor" && !sources[row.licenseBasis])
        errors.push(`${label}: manifest ${row.file} licenseBasis "${row.licenseBasis}" is not in sources.json`);
      // grant fields (.notes/song-pipeline.md §2): asserted per file, and the paper has to exist
      if (row.layer !== undefined && !GRANT_LAYERS.includes(row.layer))
        errors.push(`${label}: manifest ${row.file} layer "${row.layer}" is not one of ${GRANT_LAYERS.join(", ")}`);
      if (row.license !== undefined && !LICENSES[row.license])
        errors.push(`${label}: manifest ${row.file} license "${row.license}" is not in licenses.json`);
      if (row.obtainedVia !== undefined && !OBTAINED_VIA.includes(row.obtainedVia))
        errors.push(`${label}: manifest ${row.file} obtainedVia "${row.obtainedVia}" is not one of ${OBTAINED_VIA.join(", ")}`);
      if (row.obtainedVia === "harvest" && !row.url)
        errors.push(`${label}: manifest ${row.file} is obtainedVia "harvest" but has no url`);
      if (row.evidence && !fs.existsSync(path.join(dir, "sources", row.evidence)))
        errors.push(`${label}: manifest ${row.file} cites evidence "${row.evidence}" but sources/${row.evidence} is missing`);
    }
    for (const name of sourceFiles(dir))
      if (!listed.has(name)) errors.push(`${label}: sources/${name} has no manifest row`);

    // A master recording is only publishable with a recording grant on file. No grant, no pack.
    const master = masterAudio(dir);
    if (master) {
      const row = (manifest.files ?? []).find(r => r.file === master.rel);
      if (!song.rights?.recording)
        errors.push(`${label}: has ${master.rel} but song.json rights.recording is null — a master needs its own grant`);
      if (!row?.license) errors.push(`${label}: manifest ${master.rel} needs "license" (the grant the recording carries)`);
      if (!row?.evidence) errors.push(`${label}: manifest ${master.rel} needs "evidence" (the grant document in sources/grants/)`);
      if (!row?.submittedBy) errors.push(`${label}: manifest ${master.rel} needs "submittedBy" (who granted it)`);
      if (!row?.acquired) errors.push(`${label}: manifest ${master.rel} needs "acquired" (when it was granted)`);
    }
  }

  const stPath = sourcesTxtPath(dir);
  if (fs.existsSync(stPath)) {
    try {
      if (fs.readFileSync(stPath, "utf8") !== renderSourcesTxt(dir, song, sources))
        errors.push(`${label}: sources.txt is stale (run tools/generate.mjs)`);
    } catch (e) { errors.push(`${label}: ${e.message}`); }
  }

  if (song.writerRef && !fs.existsSync(path.join(ROOT, "writers", song.writerRef, "writer.json")))
    errors.push(`${label}: writerRef "${song.writerRef}" has no writers/ folder`);
  if (!song.id) warnings.push(`${label}: no id — build-catalog would need one; idFor(title) = ${idFor(song.title)}`);
}

// families are flat: every translation points at the base song, never at another translation
for (const [id, pid] of parentIdOf) {
  const label = ids.get(id);
  if (!ids.has(pid)) errors.push(`${label}: parent ${pid} is not in songs/`);
  else if (parentIdOf.has(pid)) errors.push(`${label}: parent ${pid} is itself a translation — link the base song`);
  else if (LICENSES[licenseOf.get(pid)]?.shareAlike && !LICENSES[licenseOf.get(id)]?.shareAlike)
    errors.push(`${label}: parent is ${licenseOf.get(pid)} but this translation is ${licenseOf.get(id)} — share-alike families cannot mix`);
}
if (fs.existsSync(path.join(ROOT, "works"))) errors.push("works/ still exists — shared assets live on the parent song now");

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`${ids.size} songs checked: ${errors.length} errors, ${warnings.length} warnings`);
if (errors.length) process.exit(1);
