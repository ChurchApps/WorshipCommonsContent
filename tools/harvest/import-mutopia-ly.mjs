// Backfills the LilyPond sources behind the Mutopia SATB PDFs we host (files.md §1.1:
// "LilyPond: kept as a source"). Reads the song list from import-mutopia.mjs so the two
// stay in step, fetches every *.ly / *.ily in each Mutopia directory into the song's
// sources/, and writes manifest rows with url + acquired date (original: true).
// Reruns skip files whose bytes are unchanged. Usage: node tools/harvest/import-mutopia-ly.mjs [--dry]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readSong, writeManifest, isoDate } from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dry = process.argv.includes("--dry");
const UA = { "User-Agent": "WorshipCommons content harvest (support@churchapps.org)" };

// [mutopiaSlug, songSlug, dirUrl] triples + the Foundation link, parsed from the PDF importer
const importer = fs.readFileSync(path.join(ROOT, "tools", "harvest", "import-mutopia.mjs"), "utf8");
const targets = [...importer.matchAll(/\["([^"]+)",\s*"([^"]+)",\s*"(https:\/\/www\.mutopiaproject\.org\/ftp\/[^"]+\/)"\]/g)]
  .map(m => ({ song: path.join(ROOT, "songs", "en", "public-domain", m[2]), url: m[3] }));
const foundation = importer.match(/link:\s*"(https:\/\/www\.mutopiaproject\.org\/ftp\/[^"]+\/)"/);
if (foundation) targets.push({ song: path.join(ROOT, "songs", "en", "cc-by-sa", "foundation"), url: foundation[1] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return r;
      if (r.status === 404) return null;
    } catch (e) { if (attempt === 3) throw e; }
    await sleep(2000 * attempt);
  }
  return null;
}

let fetched = 0, unchanged = 0, missing = 0;
for (const { song, url } of targets) {
  if (!fs.existsSync(path.join(song, "masters", "song.json"))) { console.log(`skip  ${path.basename(song)} (no package)`); missing++; continue; }
  const listing = await get(url);
  if (!listing) { console.log(`404   ${url}`); missing++; continue; }
  const names = [...new Set([...(await listing.text()).matchAll(/href="([^"?/]+\.(?:ly|ily))"/g)].map(m => m[1]))];
  if (!names.length) { console.log(`none  ${url}`); missing++; continue; }
  const urls = {}, acquired = {}, basis = {}, notes = {};
  for (const name of names) {
    const dest = path.join(song, "sources", name);
    const r = await get(url + name);
    if (!r) { console.log(`404   ${url}${name}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    urls[name] = url + name; acquired[name] = isoDate(); basis[name] = "mutopia";
    notes[name] = "LilyPond engraving source behind sheetPdf.pdf; original bytes as fetched";
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(buf)) { unchanged++; continue; }
    if (!dry) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
    fetched++;
    console.log(`${dry ? "would" : "got  "} ${path.basename(song)}/sources/${name} (${buf.length} bytes)`);
    await sleep(1000);
  }
  if (dry) continue;
  const s = readSong(song);
  writeManifest(song, { text: s.rights?.text?.source, tune: s.rights?.tune?.basis, abc: s.rights?.arrangement?.basis }, { urls, acquired, basis, notes });
}
console.log(`mutopia-ly: fetched ${fetched}, unchanged ${unchanged}, missing ${missing} of ${targets.length} targets`);
if (!dry) console.log("next: node tools/generate.mjs && node tools/build-catalog.mjs && node tools/validate.mjs");
