// Align already-split packages to the names and song.json shape in what-we-build.md:
// sources/hymnary.json + video.json, masters/cover.webp, drafted form map.
// Reruns are no-ops. Afterwards: write-sources-txt → build-catalog → validate.
// Usage: node tools/align-packages.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  songDirs, readWorks, readSong, readHarvested, writeJson, writeHarvested,
  writeManifest, lyricsPath, splitChordpro, draftForm, orderSong,
  GENERATED_COVER_RIGHTS, pdReviewNote
} from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTE = "Drafted form map from ChordPro section labels (vision/files.md).";

function rename(dir, from, to) {
  const src = path.join(dir, from), dest = path.join(dir, to);
  if (!fs.existsSync(src)) return 0;
  if (fs.existsSync(dest)) {
    if (fs.readFileSync(src).equals(fs.readFileSync(dest))) { fs.unlinkSync(src); return 0; }
    throw new Error(`${src} and ${dest} both exist and differ`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return 1;
}

const stats = { hymnary: 0, covers: 0, forms: 0, artwork: 0, review: 0, works: 0 };

for (const { dir } of songDirs(ROOT)) {
  const harvested = readHarvested(dir);
  if (fs.existsSync(path.join(dir, "sources", "harvested.json")) || harvested.hymnalCount !== undefined || harvested.churchCount !== undefined || harvested.video) {
    writeHarvested(dir, harvested);
    const song = readSong(dir);
    writeManifest(dir, { text: song.rights?.text?.source, tune: song.rights?.tune?.basis, abc: song.rights?.arrangement?.basis });
    stats.hymnary++;
  }
  stats.covers += rename(dir, "derivatives/art.webp", "masters/cover.webp");
  stats.covers += rename(dir, "derivatives/cover.webp", "masters/cover.webp");
  stats.covers += rename(dir, "derivatives/art-thumb.webp", "derivatives/cover-thumb.webp");

  const song = readSong(dir);
  const notes = [];
  if (!song.form) {
    const body = splitChordpro(fs.readFileSync(lyricsPath(dir), "utf8")).body;
    const form = draftForm(body);
    if (form) { song.form = form; notes.push(NOTE); stats.forms++; }
  } else if (!song.form.status) {
    // earlier runs drafted the map without saying so
    song.form = { status: "draft", ...song.form };
    notes.push("Form map marked draft; a reviewer sets approved.");
    stats.forms++;
  }
  // an own cover.webp with no artwork rights row: record the keep decision
  if (fs.existsSync(path.join(dir, "masters", "cover.webp")) && song.rights && !song.rights.artwork) {
    song.rights.artwork = { ...GENERATED_COVER_RIGHTS };
    notes.push("Artwork rights row added for the kept generated cover.");
    stats.artwork++;
  }
  const review = pdReviewNote(song);
  if (review && song.rights?.text && !song.rights.text.review) {
    song.rights.text.review = review;
    notes.push("Flagged post-1930 PD claim for review.");
    stats.review++;
  }
  if (notes.length) writeJson(path.join(dir, "masters", "song.json"), orderSong(song));
}

for (const work of readWorks(ROOT).values()) {
  stats.covers += rename(work.dir, "derivatives/art.webp", "masters/cover.webp");
  stats.covers += rename(work.dir, "derivatives/cover.webp", "masters/cover.webp");
  stats.covers += rename(work.dir, "derivatives/art-thumb.webp", "derivatives/cover-thumb.webp");
  stats.works++;
}

console.log(`align-packages: hymnary ${stats.hymnary}, covers renamed ${stats.covers}, form drafted/marked ${stats.forms}, artwork rows ${stats.artwork}, PD reviews flagged ${stats.review}, works ${stats.works}`);
console.log("next: node tools/generate.mjs && node tools/build-catalog.mjs && node tools/validate.mjs");
