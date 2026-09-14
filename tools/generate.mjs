// Rebuild output/composition/ from song.json + sources/. Plain Node, no npm deps.
//
//   node tools/generate.mjs                         whole library
//   node tools/generate.mjs songs/en/amazing-grace-YxPfAFYWOaG
//   node tools/generate.mjs amazing-grace           slug (songs and/or the work)
//   node tools/generate.mjs songs/en                every English song
//   node tools/generate.mjs works/amazing-grace
//
// Writes: output/composition/score.musicxml from sources/tune.abc (needs python — skipped
// with a warning when absent; a score in sources/ wins and is left alone), sources.txt, attribution.txt,
// LICENSE.txt, slides.json, duration.json, chart.chordpro (a byte copy of the lyrics master until
// the score-driven chart generator exists — files.md §3.2), chart.pdf (when the text
// encodes), cover-thumb.webp. Leaves timing.json in place (needs the score pipeline).
//
// Every new package goes through this same function, so anything imported or approved
// with an ABC source gets a master score without anyone remembering a second command.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  songDirs, readWorks, readJson, readSong, lyricsPath, splitChordpro,
  renderSourcesTxt, renderLicenseTxt, ensurePkgDirs, licenseNotice, parseChordproStanzas, stripChords
} from "./lib.mjs";
import { chartPdf } from "./generate/pdf.mjs";
import { writeThumb } from "./generate/thumb.mjs";
import { scoreFor, midiFor, pythonAvailable } from "./generate/score.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeIfChanged(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

function slidesOf(stanzas) {
  return {
    slides: stanzas.map(st => ({
      label: st.label || "Verse",
      lines: st.lines.map(stripChords).filter(Boolean)
    })).filter(s => s.lines.length)
  };
}

function durationOf(song, stanzas, existingTiming) {
  if (existingTiming?.duration) return { seconds: existingTiming.duration, basis: "timing.json" };
  const bpm = Number(song.bpm);
  const [beats] = String(song.timeSignature || "4/4").split("/").map(Number);
  const lines = stanzas.reduce((n, st) => n + st.lines.filter(l => stripChords(l)).length, 0);
  if (!bpm || !lines) return { seconds: null, basis: "unknown" };
  return {
    seconds: Math.round(lines * (beats || 4) * (60 / bpm)),
    basis: `estimate: ${lines} lines × ${beats || 4} beats @ ${bpm} bpm`
  };
}

export function generateSong(dir, { sources }) {
  const song = readSong(dir);
  if (song.submittedBy) return { skipped: true };
  ensurePkgDirs(dir);
  const out = name => path.join(dir, "output", "composition", name);
  const { body } = splitChordpro(fs.readFileSync(lyricsPath(dir), "utf8"));
  const stanzas = parseChordproStanzas(body);
  const notice = licenseNotice(song);
  const timingPath = out("timing.json");
  const timing = fs.existsSync(timingPath) ? readJson(timingPath) : null;
  const wrote = {};

  wrote.score = scoreFor(dir);
  wrote.midi = midiFor(dir);
  wrote.sources = writeIfChanged(out("sources.txt"), renderSourcesTxt(dir, song, sources));
  wrote.license = writeIfChanged(out("LICENSE.txt"), renderLicenseTxt(dir, song, sources));
  wrote.attribution = writeIfChanged(out("attribution.txt"), `${song.title}\n${song.writer ?? ""}${song.year ? `, ${song.year}` : ""}\n${notice}\n`);
  wrote.slides = writeIfChanged(out("slides.json"), JSON.stringify(slidesOf(stanzas), null, 2) + "\n");
  wrote.duration = writeIfChanged(out("duration.json"), JSON.stringify(durationOf(song, stanzas, timing), null, 2) + "\n");
  wrote.chart = writeIfChanged(out("chart.chordpro"), fs.readFileSync(lyricsPath(dir)));

  const pdf = chartPdf({
    title: song.title,
    subtitle: [song.writer, song.key && `Key of ${song.key}`, song.timeSignature, song.bpm && `${song.bpm} BPM`].filter(Boolean).join(" · "),
    footer: notice,
    stanzas
  });
  if (pdf) { writeIfChanged(out("chart.pdf"), pdf); wrote.pdf = true; }
  else wrote.skipPdf = true;

  const ownCover = path.join(dir, "sources", "cover.webp");
  const thumb = out("cover-thumb.webp");
  if (fs.existsSync(ownCover)) { writeThumb(ownCover, thumb); wrote.thumb = true; }
  else if (fs.existsSync(thumb)) fs.unlinkSync(thumb);

  return { song, wrote };
}

export function generateWork(dir) {
  const cover = path.join(dir, "sources", "cover.webp");
  const thumb = path.join(dir, "output", "composition", "cover-thumb.webp");
  const wrote = { thumb: writeThumb(cover, thumb) };
  wrote.score = scoreFor(dir);
  wrote.midi = midiFor(dir);
  return { wrote };
}

function isSongDir(dir) {
  return fs.existsSync(path.join(dir, "masters", "song.json"));
}
function isWorkDir(dir) {
  return fs.existsSync(path.join(dir, "masters", "work.json"));
}

export function resolveTargets(root, arg) {
  const songs = [...songDirs(root)];
  const works = [...readWorks(root).values()];
  if (!arg) return { songs, works };

  const tries = [...new Set([
    path.resolve(arg),
    path.resolve(root, arg),
    path.resolve(process.cwd(), arg)
  ])];
  for (const p of tries) {
    if (isSongDir(p)) return { songs: songs.filter(s => path.resolve(s.dir) === p), works: [] };
    if (isWorkDir(p)) return { songs: [], works: works.filter(w => path.resolve(w.dir) === p) };
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const underS = songs.filter(s => s.dir === p || s.dir.startsWith(prefix));
      const underW = works.filter(w => w.dir === p || w.dir.startsWith(prefix));
      if (underS.length || underW.length) return { songs: underS, works: underW };
    }
  }

  const needle = arg.replaceAll("\\", "/").replace(/\/$/, "");
  const slug = path.basename(needle);
  const songHits = songs.filter(s => s.folder === slug || s.folder.startsWith(slug + "-") || s.dir.replaceAll("\\", "/").endsWith("/" + needle) || s.dir.replaceAll("\\", "/").endsWith(needle));
  const workHits = works.filter(w => w.folder === slug || w.dir.replaceAll("\\", "/").endsWith("/" + needle) || w.dir.replaceAll("\\", "/").endsWith(needle));
  if (workHits.length) {
    const slugs = new Set(workHits.map(w => w.folder));
    for (const s of songs) {
      if (slugs.has(readSong(s.dir).workRef) && !songHits.some(h => h.dir === s.dir)) songHits.push(s);
    }
  }
  return { songs: songHits, works: workHits };
}

export function generate(root = ROOT, arg) {
  const sources = readJson(path.join(root, "sources.json"));
  const { songs, works } = resolveTargets(root, arg);
  if (arg && !songs.length && !works.length) {
    const err = new Error(`No package matched "${arg}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const stats = { songs: 0, works: 0, pdf: 0, skipPdf: 0, thumbs: 0, scores: 0, midis: 0, scoresFailed: 0, python: pythonAvailable() };
  const tally = r => {
    if (r.wrote.thumb) stats.thumbs++;
    if (["written", "unchanged", "source"].includes(r.wrote.score)) stats.scores++;
    if (["written", "unchanged"].includes(r.wrote.midi)) stats.midis++;
    if (r.wrote.midi === "failed") stats.scoresFailed++;
    if (r.wrote.score === "failed") stats.scoresFailed++;
  };
  for (const { dir } of songs) {
    const r = generateSong(dir, { sources });
    if (r.skipped) continue;
    stats.songs++;
    if (r.wrote.pdf) stats.pdf++;
    if (r.wrote.skipPdf) stats.skipPdf++;
    tally(r);
  }
  for (const w of works) {
    const r = generateWork(w.dir);
    stats.works++;
    tally(r);
  }
  return stats;
}

function usage() {
  console.log(`Usage: node tools/generate.mjs [folder]

Rebuild output/composition/ from song.json and sources/.
  (no args)     whole library
  <path>        one song or work package, or everything under a prefix
  <slug>        packages whose folder name is that slug

Writes output/composition/score.musicxml from tune.abc, chart.chordpro, chart.pdf,
slides.json, attribution.txt, duration.json, sources.txt, LICENSE.txt, cover-thumb.webp.
timing.json is left as-is.`);
}

export function run(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) { usage(); return 0; }
  const arg = argv.find(a => !a.startsWith("-"));
  try {
    const stats = generate(ROOT, arg);
    console.log(`generate: ${stats.songs} songs, ${stats.works} works, ${stats.pdf} chart.pdf, ${stats.skipPdf} pdf skipped (non-Latin), ${stats.thumbs} thumbs, ${stats.scores} scores, ${stats.midis} score.mid${stats.scoresFailed ? `, ${stats.scoresFailed} FAILED` : ""}`);
    if (!stats.python) console.warn("generate: python not found — new ABC files will not convert; existing conversions are still promoted (set PYTHON=...)");
    if (arg) console.log("next: python tools/pack/build.py " + arg + "  (required when sources/master/ has a granted mix)");
    return stats.scoresFailed ? 1 : 0;
  } catch (e) {
    if (e.code === "NOT_FOUND") { console.error(e.message); usage(); return 1; }
    throw e;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) process.exit(run());
