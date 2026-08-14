// Library sanity checks. Exit 1 on errors, prints warnings otherwise.
// Usage: node tools/validate.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, LANG_CODES, splitChordpro, renderSourcesTxt, songDirs, readJson } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = readJson(path.join(ROOT, "sources.json"));
const errors = [];
const warnings = [];

const ids = new Map(); // id → dir
const foldersSeen = new Map(); // "<section>/<lang>" → Set of lowercased folder names
const langCodes = new Set(Object.values(LANG_CODES));
const REQUIRED = ["id", "title", "writer", "language", "license", "churchCount", "hymnalCount", "timeSignature", "provenance"];
// user-submitted songs (exported from the bucket) have no provenance/sources.txt/writerRef
const REQUIRED_SUBMITTED = ["id", "title", "language", "license", "status"];

for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const label = `songs/${langDir}/${section}/${folder}`;
  let song;
  try { song = readJson(path.join(dir, "song.json")); }
  catch (e) { errors.push(`${label}: unreadable song.json — ${e.message}`); continue; }
  const submitted = !!song.submittedBy;

  for (const f of submitted ? REQUIRED_SUBMITTED : REQUIRED) if (song[f] === undefined) errors.push(`${label}: song.json missing "${f}"`);
  if (song.id && !/^[A-Za-z0-9_-]{11}$/.test(song.id)) errors.push(`${label}: id "${song.id}" is not an 11-char base64url id`);
  if (song.id && ids.has(song.id)) errors.push(`${label}: duplicate id ${song.id} (also ${ids.get(song.id)})`);
  ids.set(song.id, label);
  if (!langCodes.has(langDir)) errors.push(`${label}: unknown language dir "${langDir}"`);
  if (song.language && LANG_CODES[song.language] && LANG_CODES[song.language] !== langDir)
    errors.push(`${label}: language "${song.language}" belongs in ${LANG_CODES[song.language]}/, not ${langDir}/`);
  if ((section === "public-domain") !== (song.license === "PD"))
    errors.push(`${label}: license "${song.license}" does not match section ${section}`);

  // case-insensitive folder collisions break Windows checkouts
  const bucket = `${langDir}/${section}`;
  if (!foldersSeen.has(bucket)) foldersSeen.set(bucket, new Set());
  const lower = folder.toLowerCase();
  if (foldersSeen.get(bucket).has(lower)) errors.push(`${label}: folder name collides case-insensitively with a sibling`);
  foldersSeen.get(bucket).add(lower);

  // chordpro header must agree with song.json
  const cpPath = path.join(dir, "lyrics.chordpro");
  if (!fs.existsSync(cpPath)) { errors.push(`${label}: missing lyrics.chordpro`); continue; }
  const { header, body } = splitChordpro(fs.readFileSync(cpPath, "utf8"));
  if (!body.trim()) errors.push(`${label}: lyrics.chordpro has an empty body`);
  const expect = { title: song.title, artist: song.writer, key: song.key, time: song.timeSignature, tempo: song.bpm };
  for (const [k, v] of Object.entries(expect)) {
    if (v === null || v === undefined) continue;
    if (header[k] === undefined) warnings.push(`${label}: lyrics.chordpro missing {${k}} directive`);
    else if (String(header[k]) !== String(v)) errors.push(`${label}: {${k}} directive "${header[k]}" != song.json "${v}"`);
  }

  // provenance keys must resolve; assets present must have provenance and vice versa
  const assetFiles = { tune: "tune.mid", abc: "tune.abc", timing: "timing.json", art: "art.webp" };
  if (submitted) continue; // uploads are artist artifacts — no provenance/sources.txt/writerRef
  for (const [asset, key] of Object.entries(song.provenance ?? {})) {
    if (!sources[key]) errors.push(`${label}: provenance.${asset} references unknown source "${key}"`);
    if (asset !== "text" && !fs.existsSync(path.join(dir, assetFiles[asset] ?? "?")))
      warnings.push(`${label}: provenance.${asset} set but ${assetFiles[asset]} not present`);
  }
  for (const [asset, file] of Object.entries(assetFiles))
    if (fs.existsSync(path.join(dir, file)) && !song.provenance?.[asset])
      warnings.push(`${label}: ${file} present but provenance.${asset} not set`);

  // sources.txt must be current
  const stPath = path.join(dir, "sources.txt");
  if (!fs.existsSync(stPath)) errors.push(`${label}: missing sources.txt (run tools/write-sources-txt.mjs)`);
  else {
    try {
      if (fs.readFileSync(stPath, "utf8") !== renderSourcesTxt(song, sources))
        errors.push(`${label}: sources.txt is stale (run tools/write-sources-txt.mjs)`);
    } catch (e) { errors.push(`${label}: ${e.message}`); }
  }

  // writerRef must resolve
  if (song.writerRef) {
    const wj = path.join(ROOT, "writers", song.writerRef, "writer.json");
    if (!fs.existsSync(wj)) errors.push(`${label}: writerRef "${song.writerRef}" has no writers/ folder`);
    else if (!fs.existsSync(path.join(ROOT, "writers", song.writerRef, "portrait.jpg")))
      errors.push(`${label}: writers/${song.writerRef}/portrait.jpg missing`);
  }
  if (!song.id) warnings.push(`${label}: no id — build-catalog would need one; idFor(title) = ${idFor(song.title)}`);
}

// parent links: warn only — a parent title may predate the catalog
for (const { dir, section, langDir, folder } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  if (song.parent?.id && !ids.has(song.parent.id))
    warnings.push(`songs/${langDir}/${section}/${folder}: parent "${song.parent.title}" (${song.parent.id}) is not in the catalog`);
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`${ids.size} songs checked: ${errors.length} errors, ${warnings.length} warnings`);
if (errors.length) process.exit(1);
