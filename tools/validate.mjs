// Library sanity checks. Exit 1 on errors, prints warnings otherwise.
// Usage: node tools/validate.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  idFor, LANG_CODES, LICENSES, splitChordpro, renderSourcesTxt, songDirs, readJson,
  readWorks, readSong, lyricsPath, sourcesTxtPath, manifestPath,
  SHARED_RELS, STRAY_ROOT_FILES, sha256File, idFromFolder
} from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = readJson(path.join(ROOT, "sources.json"));
const THEMES = new Set(readJson(path.join(ROOT, "themes.json")).themes);
const works = readWorks(ROOT);
const errors = [];
const warnings = [];

const ids = new Map(); // id → dir
const parentOf = new Map(); // id → legacy parent id
const workRefOf = new Map(); // id → workRef
const workMembers = new Map(); // work slug → [song id]
const licenseOf = new Map(); // id → license code
const foldersSeen = new Map(); // "<section>/<lang>" → Set of lowercased folder names
const langCodes = new Set(Object.values(LANG_CODES));
const REQUIRED = ["id", "title", "writer", "language", "license", "timeSignature", "rights"];
const METER_RE = /^(?:\d{1,2}(?:\.\d{1,2})+(?:[ .]D)?|[CLS]MD?)$/;
const REQUIRED_SUBMITTED = ["id", "title", "language", "license", "status"];

for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const label = `songs/${langDir}/${section}/${folder}`;
  let song;
  try { song = readSong(dir); }
  catch (e) { errors.push(`${label}: unreadable song.json — ${e.message}`); continue; }
  const submitted = !!song.submittedBy;

  for (const f of submitted ? REQUIRED_SUBMITTED : REQUIRED) if (song[f] === undefined) errors.push(`${label}: song.json missing "${f}"`);
  if (song.id && !/^[A-Za-z0-9_-]{11}$/.test(song.id)) errors.push(`${label}: id "${song.id}" is not an 11-char base64url id`);
  if (song.id && ids.has(song.id)) errors.push(`${label}: duplicate id ${song.id} (also ${ids.get(song.id)})`);
  ids.set(song.id, label);
  // folder is <slug>-<id>: the same key in git and in the bucket (run tools/rename-packages.mjs)
  if (song.id && idFromFolder(folder) !== song.id) errors.push(`${label}: folder must end with "-${song.id}" (run node tools/rename-packages.mjs)`);
  if (!langCodes.has(langDir)) errors.push(`${label}: unknown language dir "${langDir}"`);
  if (song.language && LANG_CODES[song.language] && LANG_CODES[song.language] !== langDir)
    errors.push(`${label}: language "${song.language}" belongs in ${LANG_CODES[song.language]}/, not ${langDir}/`);
  for (const th of String(song.themes ?? "").split(",").map(t => t.trim()).filter(Boolean))
    if (!THEMES.has(th)) errors.push(`${label}: theme "${th}" is not in themes.json`);
  const lic = LICENSES[song.license];
  if (!lic) errors.push(`${label}: unknown license "${song.license}" — must be one of ${Object.keys(LICENSES).join(", ")}`);
  else if (lic.section !== section) errors.push(`${label}: license "${song.license}" belongs in ${lic.section}/, not ${section}/`);
  if (lic?.attributionRequired && !song.licenseUrl) errors.push(`${label}: ${song.license} songs need "licenseUrl" (the exact license the writer applied)`);
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
    errors.push(`${label}: harvested fields (hymnalCount/churchCount/video/provenance) belong in sources/, not masters/song.json`);

  const bucket = `${langDir}/${section}`;
  if (!foldersSeen.has(bucket)) foldersSeen.set(bucket, new Set());
  const lower = folder.toLowerCase();
  if (foldersSeen.get(bucket).has(lower)) errors.push(`${label}: folder name collides case-insensitively with a sibling`);
  foldersSeen.get(bucket).add(lower);

  for (const f of STRAY_ROOT_FILES)
    if (fs.existsSync(path.join(dir, f))) errors.push(`${label}: leftover ${f} at package root — belongs in sources/, masters/, or derivatives/`);

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
  if (!fs.existsSync(cpPath)) { errors.push(`${label}: missing masters/lyrics.chordpro`); continue; }
  const { header, body } = splitChordpro(fs.readFileSync(cpPath, "utf8"));
  if (!body.trim()) errors.push(`${label}: lyrics.chordpro has an empty body`);
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
    }
    const srcDir = path.join(dir, "sources");
    if (fs.existsSync(srcDir)) {
      for (const name of fs.readdirSync(srcDir)) {
        if (name === "manifest.json") continue;
        if (!fs.statSync(path.join(srcDir, name)).isFile()) continue;
        if (!listed.has(name)) errors.push(`${label}: sources/${name} has no manifest row`);
      }
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

for (const { dir, section, langDir, folder } of songDirs(ROOT)) {
  const song = readSong(dir);
  if (!song.parent?.id) continue;
  const label = `songs/${langDir}/${section}/${folder}`;
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
  for (const f of STRAY_ROOT_FILES)
    if (fs.existsSync(path.join(work.dir, f))) errors.push(`${label}: leftover ${f} at package root — belongs in sources/, masters/, or derivatives/`);
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
