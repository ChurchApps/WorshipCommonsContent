// Library sanity checks. Exit 1 on errors, prints warnings otherwise.
// Usage: node tools/validate.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  idFor, LANG_CODES, LICENSES, splitChordpro, renderSourcesTxt, songDirs, readJson,
  readWorks, readSong, lyricsPath, sourcesTxtPath, manifestPath,
  SHARED_RELS, ROOT_FILES, EITHER_RELS, sha256File, idFromFolder,
  sourceFiles, masterAudio, GRANT_LAYERS, OBTAINED_VIA
} from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = readJson(path.join(ROOT, "sources.json"));
const THEMES = new Set(readJson(path.join(ROOT, "themes.json")).themes);
const works = readWorks(ROOT);
const errors = [];
const warnings = [];

// Only song.json / work.json live at the package root; everything else is a source or an output.
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
const parentOf = new Map(); // id → legacy parent id
const workRefOf = new Map(); // id → workRef
const workMembers = new Map(); // work slug → [song id]
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
  if (song.ccli != null && song.ccli !== "" && !/^\d{5,8}$/.test(String(song.ccli))) errors.push(`${label}: ccli "${song.ccli}" is not a 5–8 digit song id`);
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

  if (song.parent?.id) parentOf.set(song.id, song.parent.id);
  const work = song.workRef ? works.get(song.workRef) : null;
  if (song.workRef) {
    workRefOf.set(song.id, song.workRef);
    if (!work) errors.push(`${label}: workRef "${song.workRef}" has no works/ folder`);
    else {
      if (!workMembers.has(song.workRef)) workMembers.set(song.workRef, []);
      workMembers.get(song.workRef).push(song.id);
      for (const rel of SHARED_RELS) {
        const sp = path.join(dir, rel), wp = path.join(work.dir, rel);
        if (fs.existsSync(sp) && fs.existsSync(wp) && fs.readFileSync(sp).equals(fs.readFileSync(wp)))
          errors.push(`${label}: ${rel} is byte-identical to works/${song.workRef}/${rel} — delete the song copy to inherit`);
      }
    }
    if (song.parent) errors.push(`${label}: has both "parent" and "workRef" — parent is derived from the work; remove it`);
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

for (const { dir, langDir, folder } of songDirs(ROOT)) {
  const song = readSong(dir);
  if (!song.parent?.id) continue;
  const label = `songs/${langDir}/${folder}`;
  if (!ids.has(song.parent.id))
    warnings.push(`${label}: parent "${song.parent.title}" (${song.parent.id}) is not in the catalog`);
  else if (parentOf.has(song.parent.id) || workRefOf.has(song.parent.id))
    errors.push(`${label}: parent ${song.parent.id} is itself a family member — link the original (or move the family to a work)`);
}

const canonicalSeen = new Map();
const workSlugsLower = new Set();
for (const [slug, work] of works) {
  const label = `works/${slug}`;
  if (work.slug !== slug) errors.push(`${label}: work.json slug "${work.slug}" != folder name`);
  const lower = slug.toLowerCase();
  if (workSlugsLower.has(lower)) errors.push(`${label}: folder name collides case-insensitively with a sibling`);
  workSlugsLower.add(lower);
  checkRoot(work.dir, label);
  checkOneOwner(work.dir, label);
  if (!fs.existsSync(manifestPath(work.dir))) errors.push(`${label}: missing sources/manifest.json`);
  if (!work.canonicalSongId) { errors.push(`${label}: work.json missing "canonicalSongId"`); continue; }
  if (!ids.has(work.canonicalSongId)) errors.push(`${label}: canonicalSongId ${work.canonicalSongId} is not in the catalog`);
  else if (workRefOf.get(work.canonicalSongId) !== slug)
    errors.push(`${label}: canonical song ${work.canonicalSongId} (${ids.get(work.canonicalSongId)}) does not have workRef "${slug}"`);
  if (canonicalSeen.has(work.canonicalSongId))
    errors.push(`${label}: canonicalSongId ${work.canonicalSongId} is already canonical of works/${canonicalSeen.get(work.canonicalSongId)}`);
  canonicalSeen.set(work.canonicalSongId, slug);
  if ((workMembers.get(slug) ?? []).length < 2) warnings.push(`${label}: fewer than 2 member songs — stale work?`);
  if (LICENSES[licenseOf.get(work.canonicalSongId)]?.shareAlike)
    for (const id of workMembers.get(slug) ?? [])
      if (!LICENSES[licenseOf.get(id)]?.shareAlike) errors.push(`${label}: canonical is ${licenseOf.get(work.canonicalSongId)} but member ${id} is ${licenseOf.get(id)} — share-alike families cannot mix`);
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`${ids.size} songs checked: ${errors.length} errors, ${warnings.length} warnings`);
if (errors.length) process.exit(1);
