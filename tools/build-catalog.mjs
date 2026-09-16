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
  readSong, readHarvested, lyricsPath, resolveShared, readManifest
} from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const rows = [];
const writerSlugs = new Set();
const works = readWorks(ROOT);
const workSlugsUsed = new Set();

for (const { langDir, folder, dir } of songDirs(ROOT)) {
  const song = readSong(dir);
  if (!song.id) throw new Error(`${dir}: song.json has no id — stamp one with idFor(title) = ${idFor(song.title)}`);
  const work = song.workRef ? works.get(song.workRef) : null;
  if (song.workRef && !work) throw new Error(`${dir}: workRef "${song.workRef}" has no works/ folder`);
  if (work) workSlugsUsed.add(work.folder);
  const { body } = splitChordpro(fs.readFileSync(lyricsPath(dir), "utf8"));
  const rootRel = ["songs", langDir, folder].join("/");
  const harvested = readHarvested(dir);
  const abc = resolveShared(rootRel, dir, work, "sources/tune.abc");
  const sketchMidi = resolveShared(rootRel, dir, work, "output/composition/score.mid", { inherit: false });
  // Stem sketch is the recording-timed MIDI. ABC hymns keep the harvested tune.mid.
  const midi = (!abc.path && sketchMidi.path) ? sketchMidi : resolveShared(rootRel, dir, work, "sources/tune.mid");
  const art = resolveShared(rootRel, dir, work, "sources/cover.webp");
  const timing = resolveShared(rootRel, dir, work, "sources/timing.json", { inherit: false });
  const scoreSource = resolveShared(rootRel, dir, work, "sources/score.musicxml");
  const scoreBuilt = resolveShared(rootRel, dir, work, "output/composition/score.musicxml");
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
    licenseVersion: song.licenseVersion ?? null,
    licenseUrl: song.licenseUrl ?? null,
    ccli: song.ccli ?? null,
    attribution: song.attribution?.text ?? null,
    // Confidence is computed, never stored. A score inherited from the work counts:
    // the tune is scored even if this member's own words are not yet underlaid.
    // A score in sources/ was given to us or proofread; a built one is only as good
    // as what it came from — ABC is trusted, a MIDI transcription is not.
    confidence: scoreSource.path ? "proofread-score"
      : scoreBuilt.path ? (abc.path ? "proofread-score" : "generated-from-midi")
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
    // the stems pack is built, not uploaded: whatever pack/build.py left behind
    if (field === "stemsZip") {
      const audio = path.join(dir, "output", "audio");
      const zip = fs.existsSync(audio) ? fs.readdirSync(audio).find(f => f.endsWith(".zip")) : null;
      row[urlCol] = zip ? `${rootRel}/output/audio/${zip}` : null;
      row[bytesCol] = zip ? fs.statSync(path.join(audio, zip)).size : null;
      // built beside the zip by pack/build.py: 30 s site preview, vocal-free karaoke bed
      const sidecar = suffix => { const f = fs.existsSync(audio) ? fs.readdirSync(audio).find(x => x.endsWith(suffix)) : null; return f ? `${rootRel}/output/audio/${f}` : null; };
      row.previewUrl = sidecar("preview.m4a");
      row.instrumentalUrl = sidecar("instrumental.m4a");
      continue;
    }
    const rel = name && fs.existsSync(path.join(dir, "sources", "master", name)) ? `sources/master/${name}`
      : name && fs.existsSync(path.join(dir, "sources", name)) ? `sources/${name}`
      : null;
    row[urlCol] = rel ? `${rootRel}/${rel}` : null;
    row[bytesCol] = rel ? fs.statSync(path.join(dir, rel)).size : null;
  }

  // prebuilt download packs: output/composition.zip (generate.mjs) and output/audio.zip (pack/build.py)
  for (const [col, rel] of [["compositionZip", "output/composition.zip"], ["audioZip", "output/audio.zip"]]) {
    const f = path.join(dir, rel);
    row[`${col}Url`] = fs.existsSync(f) ? `${rootRel}/${rel}` : null;
    row[`${col}Bytes`] = fs.existsSync(f) ? fs.statSync(f).size : null;
  }

  // granted-as-is extras (sources/extra/*): every manifest row that still exists on disk
  row.extraUrls = readManifest(dir).filter(r => r.file.startsWith("extra/") && fs.existsSync(path.join(dir, "sources", r.file))).map(r => `${rootRel}/sources/${r.file}`);

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
