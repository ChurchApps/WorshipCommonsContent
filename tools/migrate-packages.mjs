// One-shot (but rerunnable) structural migration: split every song and work
// folder into sources/, masters/, derivatives/ as specified in vision/files.md.
// Harvested metadata leaves song.json; a sources/manifest.json and
// nothing else is introduced (no versioning). Content is not converted — files move,
// facts are relocated, nothing is invented.
// Afterwards run: write-sources-txt → build-catalog → validate.
// Usage: node tools/migrate-packages.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  songDirs, readWorks, readJson, writeJson, ensurePkgDirs, splitHarvested,
  writeManifest, writeHarvested
} from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTE = "Structural migration to sources/masters/derivatives. Content unchanged.";
const REVIEWER = "migrate-packages";

const SONG_MOVES = {
  "lyrics.chordpro": "masters/lyrics.chordpro",
  "tune.mid": "sources/tune.mid",
  "tune.abc": "sources/tune.abc",
  "sheetPdf.pdf": "sources/sheetPdf.pdf",
  "timing.json": "derivatives/timing.json",
  "art.webp": "masters/cover.webp",
  "art-thumb.webp": "derivatives/cover-thumb.webp",
  "cover.webp": "masters/cover.webp",
  "sources.txt": "derivatives/sources.txt"
};

const WORK_MOVES = {
  "tune.mid": "sources/tune.mid",
  "tune.abc": "sources/tune.abc",
  "art.webp": "masters/cover.webp",
  "art-thumb.webp": "derivatives/cover-thumb.webp",
  "cover.webp": "masters/cover.webp"
};

function moveTo(dir, mapping) {
  let moved = 0;
  ensurePkgDirs(dir);
  for (const [from, to] of Object.entries(mapping)) {
    const src = path.join(dir, from);
    const dest = path.join(dir, to);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      if (fs.readFileSync(src).equals(fs.readFileSync(dest))) fs.unlinkSync(src);
      else throw new Error(`${src} and ${dest} both exist and differ`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    moved++;
  }
  return moved;
}

const stats = { songs: 0, works: 0, skipped: 0, moved: 0 };
const provenanceById = new Map();

for (const { dir, section, langDir, folder } of songDirs(ROOT)) {
  const label = `songs/${langDir}/${section}/${folder}`;
  const flat = path.join(dir, "song.json");
  const nested = path.join(dir, "masters", "song.json");
  if (!fs.existsSync(flat) && fs.existsSync(nested)) { stats.skipped++; continue; }
  if (!fs.existsSync(flat)) throw new Error(`${label}: no song.json`);

  const song = readJson(flat);
  provenanceById.set(song.id, song.provenance ?? {});
  stats.moved += moveTo(dir, SONG_MOVES);

  const { masters, harvested, provenance } = splitHarvested(song);
  writeJson(nested, masters);
  fs.unlinkSync(flat);
  if (Object.keys(harvested).length) writeHarvested(dir, harvested);
  writeManifest(dir, provenance);
  stats.songs++;
}

const works = readWorks(ROOT);
for (const [slug, work] of works) {
  const dir = work.dir;
  const label = `works/${slug}`;
  const flat = path.join(dir, "work.json");
  const nested = path.join(dir, "masters", "work.json");
  if (!fs.existsSync(flat) && fs.existsSync(nested)) { stats.skipped++; continue; }
  if (!fs.existsSync(flat)) throw new Error(`${label}: no work.json`);

  const json = readJson(flat);
  stats.moved += moveTo(dir, WORK_MOVES);
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  writeJson(nested, json);
  fs.unlinkSync(flat);
  const provenance = provenanceById.get(json.canonicalSongId) ?? {};
  writeManifest(dir, provenance);
  stats.works++;
}

console.log(`migrate-packages: ${stats.songs} songs, ${stats.works} works, ${stats.moved} files moved, ${stats.skipped} already migrated`);
console.log("next: node tools/generate.mjs && node tools/build-catalog.mjs && node tools/validate.mjs");
