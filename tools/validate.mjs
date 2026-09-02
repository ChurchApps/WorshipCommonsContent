// Library sanity checks. Exit 1 on errors, prints warnings otherwise.
// Usage: node tools/validate.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, LANG_CODES, splitChordpro, renderSourcesTxt, songDirs, readJson, readWorks } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = readJson(path.join(ROOT, "sources.json"));
const works = readWorks(ROOT);
const errors = [];
const warnings = [];

const ids = new Map(); // id → dir
const parentOf = new Map(); // id → legacy parent id
const workRefOf = new Map(); // id → workRef
const workMembers = new Map(); // work slug → [song id]
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
  if (song.licenseSource) {
    if (!sources[song.licenseSource]) errors.push(`${label}: licenseSource references unknown source "${song.licenseSource}"`);
    if (song.license !== "PD") errors.push(`${label}: licenseSource is only valid for public-domain songs`);
  }

  // case-insensitive folder collisions break Windows checkouts
  const bucket = `${langDir}/${section}`;
  if (!foldersSeen.has(bucket)) foldersSeen.set(bucket, new Set());
  const lower = folder.toLowerCase();
  if (foldersSeen.get(bucket).has(lower)) errors.push(`${label}: folder name collides case-insensitively with a sibling`);
  foldersSeen.get(bucket).add(lower);

  // work membership: workRef must resolve; parent (legacy) and workRef are mutually exclusive
  if (song.parent?.id) parentOf.set(song.id, song.parent.id);
  const work = song.workRef ? works.get(song.workRef) : null;
  if (song.workRef) {
    workRefOf.set(song.id, song.workRef);
    if (!work) errors.push(`${label}: workRef "${song.workRef}" has no works/ folder`);
    else {
      if (!workMembers.has(song.workRef)) workMembers.set(song.workRef, []);
      workMembers.get(song.workRef).push(song.id);
      // a same-named file in the song folder is an override — byte-identical means it should be deleted
      for (const f of ["tune.mid", "tune.abc", "art.webp"]) {
        const sp = path.join(dir, f), wp = path.join(work.dir, f);
        if (fs.existsSync(sp) && fs.existsSync(wp) && fs.readFileSync(sp).equals(fs.readFileSync(wp)))
          errors.push(`${label}: ${f} is byte-identical to works/${song.workRef}/${f} — delete the song copy to inherit`);
      }
    }
    if (song.parent) errors.push(`${label}: has both "parent" and "workRef" — parent is derived from the work; remove it`);
  }

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
  // timing.json is per-language and never inherited; the other assets may come from the work
  const hasAsset = f => fs.existsSync(path.join(dir, f)) || (!!work && f !== "timing.json" && fs.existsSync(path.join(work.dir, f)));
  for (const [asset, key] of Object.entries(song.provenance ?? {})) {
    if (!sources[key]) errors.push(`${label}: provenance.${asset} references unknown source "${key}"`);
    if (asset !== "text" && !hasAsset(assetFiles[asset] ?? "?"))
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

  // writerRef must resolve; portrait.jpg is optional (bio-only writer pages are valid)
  if (song.writerRef && !fs.existsSync(path.join(ROOT, "writers", song.writerRef, "writer.json")))
    errors.push(`${label}: writerRef "${song.writerRef}" has no writers/ folder`);
  if (!song.id) warnings.push(`${label}: no id — build-catalog would need one; idFor(title) = ${idFor(song.title)}`);
}

// legacy parent links: unresolvable is warn-only (a parent title may predate the
// catalog), but chains are errors — families must be one level deep
for (const { dir, section, langDir, folder } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  if (!song.parent?.id) continue;
  const label = `songs/${langDir}/${section}/${folder}`;
  if (!ids.has(song.parent.id))
    warnings.push(`${label}: parent "${song.parent.title}" (${song.parent.id}) is not in the catalog`);
  else if (parentOf.has(song.parent.id) || workRefOf.has(song.parent.id))
    errors.push(`${label}: parent ${song.parent.id} is itself a family member — link the original (or move the family to a work)`);
}

// works: slug matches folder, canonical is a member, one work per canonical
const canonicalSeen = new Map(); // canonicalSongId → slug
const workSlugsLower = new Set();
for (const [slug, work] of works) {
  const label = `works/${slug}`;
  if (work.slug !== slug) errors.push(`${label}: work.json slug "${work.slug}" != folder name`);
  const lower = slug.toLowerCase();
  if (workSlugsLower.has(lower)) errors.push(`${label}: folder name collides case-insensitively with a sibling`);
  workSlugsLower.add(lower);
  if (!work.canonicalSongId) { errors.push(`${label}: work.json missing "canonicalSongId"`); continue; }
  if (!ids.has(work.canonicalSongId)) errors.push(`${label}: canonicalSongId ${work.canonicalSongId} is not in the catalog`);
  else if (workRefOf.get(work.canonicalSongId) !== slug)
    errors.push(`${label}: canonical song ${work.canonicalSongId} (${ids.get(work.canonicalSongId)}) does not have workRef "${slug}"`);
  if (canonicalSeen.has(work.canonicalSongId))
    errors.push(`${label}: canonicalSongId ${work.canonicalSongId} is already canonical of works/${canonicalSeen.get(work.canonicalSongId)}`);
  canonicalSeen.set(work.canonicalSongId, slug);
  if ((workMembers.get(slug) ?? []).length < 2) warnings.push(`${label}: fewer than 2 member songs — stale work?`);
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`${ids.size} songs checked: ${errors.length} errors, ${warnings.length} warnings`);
if (errors.length) process.exit(1);
