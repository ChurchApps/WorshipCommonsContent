// Walks the song and writer folders and emits catalog.json — the one-file form of
// the whole library that the WorshipCommons API vendors (config/catalog.json).
// Usage: node tools/build-catalog.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, splitChordpro, songDirs, readJson, writeJson } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const rows = [];
const files = [];
const writerSlugs = new Set();

for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  if (!song.id) throw new Error(`${dir}: song.json has no id — stamp one with idFor(title) = ${idFor(song.title)}`);
  const { body } = splitChordpro(fs.readFileSync(path.join(dir, "lyrics.chordpro"), "utf8"));
  const rel = f => fs.existsSync(path.join(dir, f));
  const libSrc = f => ["songs", langDir, section, folder, f].join("/");
  const id = song.id;

  const row = {
    id,
    title: song.title,
    writer: song.writer,
    year: song.year,
    themes: song.themes,
    songKey: song.key,
    bpm: song.bpm,
    timeSignature: song.timeSignature,
    language: song.language,
    scripture: song.scripture,
    scriptureText: song.scriptureText ?? null,
    license: song.license,
    churchCount: song.churchCount,
    hymnalCount: song.hymnalCount,
    chordPro: body,
    parentSongId: song.parent ? song.parent.id : null,
    relationLabel: song.relationLabel ?? null,
    status: "approved",
    certified: true,
    // url columns hold bucket keys here; the API reader prefixes its contentRoot
    midiUrl: rel("tune.mid") ? `songs/${id}/tune.mid` : null,
    midiBytes: rel("tune.mid") ? fs.statSync(path.join(dir, "tune.mid")).size : null,
    lyricsUrl: rel("timing.json") ? `songs/${id}/lyrics.json` : null,
    abcUrl: rel("tune.abc") ? `songs/${id}/tune.abc` : null,
    videoUrl: song.video ? `https://www.youtube.com/watch?v=${song.video.youtube}` : null,
    artUrl: rel("art.webp") ? `songs/${id}/art.webp` : null,
    writerPortraitUrl: null,
    writerBio: null
  };

  if (rel("tune.mid")) files.push({ songId: id, src: libSrc("tune.mid"), key: `songs/${id}/tune.mid` });
  if (rel("timing.json")) files.push({ songId: id, src: libSrc("timing.json"), key: `songs/${id}/lyrics.json` });
  if (rel("tune.abc")) files.push({ songId: id, src: libSrc("tune.abc"), key: `songs/${id}/tune.abc` });
  if (rel("art.webp")) files.push({ songId: id, src: libSrc("art.webp"), key: `songs/${id}/art.webp` });

  if (song.writerRef) {
    const wdir = path.join(ROOT, "writers", song.writerRef);
    const writer = readJson(path.join(wdir, "writer.json"));
    row.writerPortraitUrl = `writers/${writer.slug}.jpg`;
    row.writerBio = writer.bio;
    if (!writerSlugs.has(writer.slug)) {
      writerSlugs.add(writer.slug);
      files.push({ songId: id, src: `writers/${writer.slug}/portrait.jpg`, key: `writers/${writer.slug}.jpg` });
    }
  }
  rows.push(row);
}

const dupes = rows.map(r => r.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate song ids: ${[...new Set(dupes)].join(", ")}`);

writeJson(path.join(ROOT, "catalog.json"), { rows, files });
console.log(`catalog.json: ${rows.length} songs, ${files.length} content files, ${writerSlugs.size} writer portraits`);
