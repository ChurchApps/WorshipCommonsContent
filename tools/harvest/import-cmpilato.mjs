// Imports a clone of github.com/cmpilato/worship-music (or a staging copy of it) into
// songs/en/<section>/<slug>/. Each composition folder there has a README.md with the lyrics
// and a "Copyright/License" block, a MuseScore .mscz, and usually .musicxml + .pdf exports.
// The README license line decides the row license: "CC-BY-3.0" → CC-BY (licenseVersion 3.0),
// "Public Domain" → PD with licenseSource cmpilato. Anything else is skipped and reported.
// Plain Node ESM, zero dependencies. Usage: node tools/harvest/import-cmpilato.mjs <staging-dir>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, LICENSES, slugify, renderChordpro, writeJson } from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = "cmpilato";
const SOURCE_URL = "https://github.com/cmpilato/worship-music";
const stagingDir = process.argv[2];
if (!stagingDir || !fs.existsSync(stagingDir)) { console.error("Usage: node tools/harvest/import-cmpilato.mjs <staging-dir>"); process.exit(1); }

// musicxml <fifths> → key name; minor keys get an "m" suffix
const MAJOR = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const MINOR = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"];
const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1]?.trim();

function readMusicXml(dir) {
  const file = fs.readdirSync(dir).find(f => f.endsWith(".musicxml"));
  if (!file) return {};
  const xml = fs.readFileSync(path.join(dir, file), "utf8");
  const fifths = Number(tag(xml, "fifths"));
  const minor = tag(xml, "mode") === "minor";
  const beats = tag(xml, "beats"), beatType = tag(xml, "beat-type");
  // <sound tempo> is always quarter-note bpm; <per-minute> is in the score's beat unit
  const tempo = xml.match(/<sound[^>]*tempo="([\d.]+)"/)?.[1];
  return {
    key: Number.isFinite(fifths) ? (minor ? MINOR : MAJOR)[fifths + 7] : undefined,
    timeSignature: beats && beatType ? `${beats}/${beatType}` : undefined,
    bpm: tempo ? Math.round(Number(tempo)) : undefined,
    composer: xml.match(/<creator type="composer">([^<]*)<\/creator>/)?.[1]?.trim().replace(/;\s*/g, ", ")
  };
}

// credits the README states in prose (no © line, no musicxml) — checked by hand against the source repo
const OVERRIDES = {
  To_God_Be_the_Glory_Praise_the_Lord: { writer: "Fanny J. Crosby, William Howard Doane, C. Michael Pilato", year: 2009 },
  Where_You_Lead: { year: 2018 }
};

// README: "# Title", "## Lyrics" (stanzas separated by blank lines), "## Copyright/License" block
function readReadme(dir) {
  const md = fs.readFileSync(path.join(dir, "README.md"), "utf8").replace(/\r\n/g, "\n");
  const title = md.match(/^# (.+)$/m)?.[1]?.trim();
  const section = name => md.split(/^## /m).find(s => s.startsWith(name))?.slice(name.length).trim() ?? "";
  const lyrics = section("Lyrics").split(/\n\s*\n/).map(st => st.split("\n").map(l => l.replace(/\s+$/, "")).filter(Boolean)).filter(st => st.length);
  const license = section("Copyright/License");
  return { title, lyrics, license };
}

// ponytail: stanza labels are a heuristic — a stanza that repeats verbatim is the Chorus, the rest are verses in order
function chordproBody(stanzas) {
  const counts = new Map();
  for (const st of stanzas) counts.set(st.join("\n"), (counts.get(st.join("\n")) ?? 0) + 1);
  let verse = 0;
  return stanzas.map(st => `${counts.get(st.join("\n")) > 1 ? "Chorus" : `Verse ${++verse}`}\n${st.join("\n")}`).join("\n\n");
}

let imported = 0;
const skipped = [];
for (const folder of fs.readdirSync(stagingDir).sort()) {
  const dir = path.join(stagingDir, folder);
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, "README.md"))) continue;
  const { title, lyrics, license: licText } = readReadme(dir);
  const xml = readMusicXml(dir);
  const cc = licText.match(/CC-BY-3\.0\]\((https:\/\/creativecommons\.org\/licenses\/by\/3\.0\/)\)/);
  const pd = /public domain/i.test(licText);
  if (!title || !lyrics.length || (!cc && !pd)) { skipped.push(`${folder}: ${!title ? "no title" : !lyrics.length ? "no lyrics" : "license not CC BY 3.0 or Public Domain"}`); continue; }

  const copyright = licText.match(/[©@]\s*(\d{4})\s+([^;\n]+)/);
  const years = [...licText.matchAll(/\b(19|20)\d{2}\b/g)].map(m => Number(m[0]));
  const writer = OVERRIDES[folder]?.writer || xml.composer || copyright?.[2]?.trim() || "C. Michael Pilato";
  const year = OVERRIDES[folder]?.year ?? (copyright ? Number(copyright[1]) : years.length ? Math.max(...years) : null);
  const license = cc ? "CC-BY" : "PD";
  const outDir = path.join(ROOT, "songs", "en", LICENSES[license].section, slugify(title));
  fs.mkdirSync(outDir, { recursive: true });

  const pdf = fs.readdirSync(dir).find(f => f.endsWith(".pdf"));
  if (pdf) fs.copyFileSync(path.join(dir, pdf), path.join(outDir, "sheetPdf.pdf"));

  const song = {
    id: idFor(title),
    title,
    writer,
    year,
    language: "English",
    themes: "",
    key: xml.key,
    bpm: xml.bpm,
    timeSignature: xml.timeSignature ?? "4/4", // ponytail: lyrics-only folders have no score to read; 4/4 is the upload form's default too
    scripture: null,
    license,
    ...(cc ? { licenseVersion: "3.0", licenseUrl: cc[1] } : { licenseSource: SOURCE }),
    attribution: { required: !!cc, text: writer, link: `${SOURCE_URL}/tree/main/${folder}` },
    churchCount: 0,
    hymnalCount: 0,
    provenance: { text: SOURCE },
    ...(pdf ? { uploads: { sheetPdf: "sheetPdf.pdf" } } : {})
  };
  writeJson(path.join(outDir, "song.json"), song);
  fs.writeFileSync(path.join(outDir, "lyrics.chordpro"), renderChordpro(song, chordproBody(lyrics)));
  imported++;
}
for (const s of skipped) console.warn(`SKIP  ${s}`);
console.log(`imported ${imported} songs from ${stagingDir}; run tools/write-sources-txt.mjs, build-catalog.mjs, validate.mjs`);
