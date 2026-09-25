// Rebuild output/composition/ from song.json + sources/. Plain Node, no npm deps.
//
//   node tools/generate.mjs                         whole library
//   node tools/generate.mjs songs/en/amazing-grace-YxPfAFYWOaG
//   node tools/generate.mjs amazing-grace           slug (the song and its translations)
//   node tools/generate.mjs songs/en                every English song
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
import { spawnSync } from "node:child_process";
import {
  songDirs, readJson, readSong, idFromFolder, lyricsPath, splitChordpro,
  renderSourcesTxt, renderLicenseTxt, ensurePkgDirs, licenseNotice, attributionText, parseChordproStanzas, stripChords
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

function masterSeconds(dir) {
  const master = path.join(dir, "sources", "master");
  const file = fs.existsSync(master) && fs.readdirSync(master).find(f => /\.(wav|m4a|mp3|flac|mp4)$/i.test(f));
  if (!file) return null;
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(master, file)], { encoding: "utf8" });
  const s = Number(r.stdout);
  return r.status === 0 && s > 0 ? Math.round(s) : null;
}

function durationOf(song, stanzas, existingTiming, dir) {
  if (existingTiming?.duration) return { seconds: existingTiming.duration, basis: "timing.json" };
  const fromMaster = masterSeconds(dir);
  if (fromMaster) return { seconds: fromMaster, basis: "sources/master (ffprobe)" };
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
  wrote.attribution = writeIfChanged(out("attribution.txt"), attributionText(song));
  wrote.slides = writeIfChanged(out("slides.json"), JSON.stringify(slidesOf(stanzas), null, 2) + "\n");
  wrote.duration = writeIfChanged(out("duration.json"), JSON.stringify(durationOf(song, stanzas, timing, dir), null, 2) + "\n");
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
  wrote.zip = writeCompositionZip(dir);

  return { song, wrote };
}

// output/composition.zip: the print/notation set as one download (root-level entries, no folder).
// Rebuilt only when an input is newer than the zip. tools/generate/zip.py fixes entry timestamps so
// the archive is byte-identical wherever and whenever it is rebuilt — the bucket copy must match a
// fresh clone's build.
const ZIP_SKIP = new Set(["slides.json", "duration.json", "cover-thumb.webp"]);
const ZIP_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), "generate", "zip.py");
function writeCompositionZip(dir) {
  const comp = path.join(dir, "output", "composition");
  const files = [
    ...fs.readdirSync(comp).filter(f => !ZIP_SKIP.has(f)).map(f => path.join(comp, f)),
    ...["sheetPdf.pdf", "tune.abc", "tune.mid"].map(f => path.join(dir, "sources", f)).filter(f => fs.existsSync(f))
  ];
  const zip = path.join(dir, "output", "composition.zip");
  const newest = Math.max(...files.map(f => fs.statSync(f).mtimeMs));
  if (fs.existsSync(zip) && fs.statSync(zip).mtimeMs >= newest) return "unchanged";
  if (!pythonAvailable()) return "skipped";
  const r = spawnSync(process.env.PYTHON || "python", [ZIP_PY, zip, ...files], { encoding: "utf8" });
  return r.status === 0 ? "written" : "failed";
}

function isSongDir(dir) {
  return fs.existsSync(path.join(dir, "song.json"));
}

export function resolveTargets(root, arg) {
  const songs = [...songDirs(root)];
  if (!arg) return { songs };

  const tries = [...new Set([
    path.resolve(arg),
    path.resolve(root, arg),
    path.resolve(process.cwd(), arg)
  ])];
  for (const p of tries) {
    if (isSongDir(p)) return { songs: songs.filter(s => path.resolve(s.dir) === p) };
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const underS = songs.filter(s => s.dir === p || s.dir.startsWith(prefix));
      if (underS.length) return { songs: underS };
    }
  }

  const needle = arg.replaceAll("\\", "/").replace(/\/$/, "");
  const slug = path.basename(needle);
  const songHits = songs.filter(s => s.folder === slug || s.folder.startsWith(slug + "-") || s.dir.replaceAll("\\", "/").endsWith("/" + needle) || s.dir.replaceAll("\\", "/").endsWith(needle));
  // a slug hit pulls in the family: the translations of a hit, and the parent of a hit
  const ids = new Set(songHits.map(s => idFromFolder(s.folder)));
  for (const s of songHits) { const pid = readSong(s.dir).parent?.id; if (pid) ids.add(pid); }
  for (const s of songs) {
    if (songHits.includes(s)) continue;
    const song = readSong(s.dir);
    if (ids.has(song.parent?.id) || ids.has(song.id)) songHits.push(s);
  }
  return { songs: songHits };
}

export function generate(root = ROOT, arg) {
  const sources = readJson(path.join(root, "sources.json"));
  const { songs } = resolveTargets(root, arg);
  if (arg && !songs.length) {
    const err = new Error(`No package matched "${arg}"`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const stats = { songs: 0, pdf: 0, skipPdf: 0, thumbs: 0, scores: 0, midis: 0, scoresFailed: 0, python: pythonAvailable() };
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
  return stats;
}

function usage() {
  console.log(`Usage: node tools/generate.mjs [folder]

Rebuild output/composition/ from song.json and sources/.
  (no args)     whole library
  <path>        one song package, or everything under a prefix
  <slug>        the song whose folder name is that slug, and its translations

Writes output/composition/score.musicxml from tune.abc, chart.chordpro, chart.pdf,
slides.json, attribution.txt, duration.json, sources.txt, LICENSE.txt, cover-thumb.webp.
timing.json is left as-is.`);
}

export function run(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) { usage(); return 0; }
  const arg = argv.find(a => !a.startsWith("-"));
  try {
    const stats = generate(ROOT, arg);
    console.log(`generate: ${stats.songs} songs, ${stats.pdf} chart.pdf, ${stats.skipPdf} pdf skipped (non-Latin), ${stats.thumbs} thumbs, ${stats.scores} scores, ${stats.midis} score.mid${stats.scoresFailed ? `, ${stats.scoresFailed} FAILED` : ""}`);
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
