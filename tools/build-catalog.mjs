// Walks the song and writer folders and emits catalog.json — the one-file form of
// the whole library that the WorshipCommons API vendors (config/catalog.json).
// The content bucket mirrors this repo from songs/ and writers/ down, so url
// columns are repo-relative paths; the API reader prefixes its contentRoot.
// Usage: node tools/build-catalog.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, splitChordpro, songDirs, readJson, readWorks, writeJson } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const rows = [];
const writerSlugs = new Set();
const works = readWorks(ROOT);
const workSlugsUsed = new Set();

for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  if (!song.id) throw new Error(`${dir}: song.json has no id — stamp one with idFor(title) = ${idFor(song.title)}`);
  const work = song.workRef ? works.get(song.workRef) : null;
  if (song.workRef && !work) throw new Error(`${dir}: workRef "${song.workRef}" has no works/ folder`);
  if (work) workSlugsUsed.add(work.folder);
  const { body } = splitChordpro(fs.readFileSync(path.join(dir, "lyrics.chordpro"), "utf8"));
  const rel = f => fs.existsSync(path.join(dir, f));
  const libSrc = f => ["songs", langDir, section, folder, f].join("/");
  const bytes = f => fs.statSync(path.join(dir, f)).size;
  // shared assets resolve song folder first (override), then the song's work folder
  const shared = f =>
    rel(f) ? { url: libSrc(f), bytes: bytes(f) }
    : work && fs.existsSync(path.join(work.dir, f)) ? { url: `works/${work.folder}/${f}`, bytes: fs.statSync(path.join(work.dir, f)).size }
    : { url: null, bytes: null };
  const midi = shared("tune.mid"), abc = shared("tune.abc"), art = shared("art.webp");

  const row = {
    id: song.id,
    title: song.title,
    writer: song.writer,
    year: song.year,
    themes: song.themes,
    songKey: song.key,
    bpm: song.bpm,
    timeSignature: song.timeSignature,
    meter: song.meter ?? null,
    language: song.language,
    scripture: song.scripture,
    scriptureText: song.scriptureText ?? null,
    license: song.license,
    churchCount: song.churchCount,
    hymnalCount: song.hymnalCount,
    chordPro: body,
    // legacy song.parent kept as fallback; curated songs derive parent from their work
    parentSongId: song.parent ? song.parent.id : (work && work.canonicalSongId !== song.id ? work.canonicalSongId : null),
    relationLabel: song.relationLabel ?? null,
    // curated songs are approved/certified; exported submissions carry their own state
    status: song.status ?? "approved",
    submittedBy: song.submittedBy ?? null,
    proAnswer: song.proAnswer ?? null,
    certified: song.certified ?? true,
    // url columns hold repo-relative paths (= bucket keys); the API reader prefixes its contentRoot
    midiUrl: midi.url,
    midiBytes: midi.bytes,
    lyricsUrl: rel("timing.json") ? libSrc("timing.json") : null,
    abcUrl: abc.url,
    videoUrl: song.video ? `https://www.youtube.com/watch?v=${song.video.youtube}` : null,
    artUrl: art.url,
    writerPortraitUrl: null,
    writerBio: null
  };

  // submission uploads (demo audio, sheet PDF, stems) — song.json lists the filenames
  for (const [field, urlCol, bytesCol] of [
    ["demoAudio", "demoAudioUrl", "demoAudioBytes"],
    ["sheetPdf", "sheetPdfUrl", "sheetPdfBytes"],
    ["stemsZip", "stemsZipUrl", "stemsZipBytes"]
  ]) {
    const name = song.uploads?.[field];
    row[urlCol] = name && rel(name) ? libSrc(name) : null;
    row[bytesCol] = name && rel(name) ? bytes(name) : null;
  }

  if (song.writerRef) {
    const wdir = path.join(ROOT, "writers", song.writerRef);
    const writer = readJson(path.join(wdir, "writer.json"));
    row.writerPortraitUrl = `writers/${writer.slug}/portrait.jpg`;
    row.writerBio = writer.bio;
    writerSlugs.add(writer.slug);
  }
  rows.push(row);
}

const dupes = rows.map(r => r.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate song ids: ${[...new Set(dupes)].join(", ")}`);

writeJson(path.join(ROOT, "catalog.json"), { rows });
console.log(`catalog.json: ${rows.length} songs, ${writerSlugs.size} writer portraits, ${workSlugsUsed.size} works`);
