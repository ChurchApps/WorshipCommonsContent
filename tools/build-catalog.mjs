// Walks the song and writer folders and emits catalog.json — the one-file form of
// the whole library that the WorshipCommons API vendors (config/catalog.json).
// The content bucket mirrors this repo from songs/ and writers/ down, so url
// columns are repo-relative paths; the API reader prefixes its contentRoot.
// Usage: node tools/build-catalog.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  idFor, splitChordpro, songDirs, readJson, readWorks, writeJson,
  readSong, readHarvested, lyricsPath, resolveShared
} from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const rows = [];
const writerSlugs = new Set();
const works = readWorks(ROOT);
const workSlugsUsed = new Set();

for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const song = readSong(dir);
  if (!song.id) throw new Error(`${dir}: song.json has no id — stamp one with idFor(title) = ${idFor(song.title)}`);
  const work = song.workRef ? works.get(song.workRef) : null;
  if (song.workRef && !work) throw new Error(`${dir}: workRef "${song.workRef}" has no works/ folder`);
  if (work) workSlugsUsed.add(work.folder);
  const { body } = splitChordpro(fs.readFileSync(lyricsPath(dir), "utf8"));
  const rootRel = ["songs", langDir, section, folder].join("/");
  const harvested = readHarvested(dir);
  const midi = resolveShared(rootRel, dir, work, "sources/tune.mid");
  const abc = resolveShared(rootRel, dir, work, "sources/tune.abc");
  const art = (() => {
    const cover = resolveShared(rootRel, dir, work, "masters/cover.webp");
    if (cover.path) return cover;
    const legacy = resolveShared(rootRel, dir, work, "derivatives/cover.webp");
    return legacy.path ? legacy : resolveShared(rootRel, dir, work, "derivatives/art.webp");
  })();
  const timing = resolveShared(rootRel, dir, work, "derivatives/timing.json", { inherit: false });
  const sheetName = song.uploads?.sheetPdf ?? "sheetPdf.pdf";
  const sheet = resolveShared(rootRel, dir, work, `sources/${sheetName}`, { inherit: false });
  const video = harvested.video ?? song.video;

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
    // what-we-build.md: confidence is "what masters/ holds", computed, never stored.
    // A master score inherited from the work counts: the tune is scored even if this
    // member's own words are not yet underlaid (files.md §3.1). Open Hymnal ABC
    // conversions live in masters/. Leftover derivatives/score.musicxml is MIDI-derived.
    confidence: resolveShared(rootRel, dir, work, "masters/score.musicxml").path ? "proofread-score"
      : resolveShared(rootRel, dir, work, "derivatives/score.musicxml").path ? "generated-from-midi"
      : /\[[A-G][#b]?/.test(body) ? "chart-only"
      : "lyrics-only",
    churchCount: harvested.churchCount ?? song.churchCount ?? 0,
    hymnalCount: harvested.hymnalCount ?? song.hymnalCount ?? 0,
    chordPro: body,
    parentSongId: song.parent ? song.parent.id : (work && work.canonicalSongId !== song.id ? work.canonicalSongId : null),
    relationLabel: song.relationLabel ?? null,
    status: song.status ?? "approved",
    submittedBy: song.submittedBy ?? null,
    proAnswer: song.proAnswer ?? null,
    certified: song.certified ?? true,
    midiUrl: midi.url,
    midiBytes: midi.bytes,
    lyricsUrl: timing.url,
    abcUrl: abc.url,
    videoUrl: video?.youtube ? `https://www.youtube.com/watch?v=${video.youtube}` : null,
    artUrl: art.url,
    writerPortraitUrl: null,
    writerBio: null
  };

  for (const [field, urlCol, bytesCol] of [
    ["demoAudio", "demoAudioUrl", "demoAudioBytes"],
    ["sheetPdf", "sheetPdfUrl", "sheetPdfBytes"],
    ["stemsZip", "stemsZipUrl", "stemsZipBytes"]
  ]) {
    const name = song.uploads?.[field];
    if (field === "sheetPdf") {
      row[urlCol] = sheet.url;
      row[bytesCol] = sheet.bytes;
      continue;
    }
    const rel = name && fs.existsSync(path.join(dir, "sources", name)) ? `sources/${name}`
      : name && fs.existsSync(path.join(dir, name)) ? name
      : name && fs.existsSync(path.join(dir, "masters", "recording", name)) ? `masters/recording/${name}`
      : null;
    row[urlCol] = rel ? `${rootRel}/${rel}` : null;
    row[bytesCol] = rel ? fs.statSync(path.join(dir, rel)).size : null;
  }

  if (song.writerRef) {
    const wdir = path.join(ROOT, "writers", song.writerRef);
    const writer = readJson(path.join(wdir, "writer.json"));
    if (fs.existsSync(path.join(wdir, "portrait.jpg"))) row.writerPortraitUrl = `writers/${writer.slug}/portrait.jpg`;
    row.writerBio = writer.bio;
    writerSlugs.add(writer.slug);
  }
  rows.push(row);
}

const dupes = rows.map(r => r.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate song ids: ${[...new Set(dupes)].join(", ")}`);

writeJson(path.join(ROOT, "catalog.json"), { rows });
console.log(`catalog.json: ${rows.length} songs, ${writerSlugs.size} writer portraits, ${workSlugsUsed.size} works`);
