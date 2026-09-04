// Full-catalog coverage report. Plain Node, zero deps.
// Usage: node tools/harvest/scan-coverage.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { songDirs, splitChordpro, readJson, readWorks } from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHORD = /\[[A-G][#b]?[^\]]*\]/;
const works = readWorks(ROOT);

const buckets = {
  total: 0,
  hasChords: 0,
  noChords: 0,
  partialChords: 0,
  midi: 0,
  midiNoTiming: 0,
  timing: 0,
  abc: 0,
  abcNoMidi: 0,
  pdf: 0,
  pdfNoChords: 0,
  playable: 0, // midi + timing
  charted: 0,  // all lyric stanzas have at least one chord
};
const samples = {
  partialChords: [],
  midiNoTiming: [],
  pdfNoChords: [],
  abcNoMidi: [],
  noChords: [],
};
const byLang = {};
const bySection = {};

function pushSample(key, label, max = 12) {
  if (samples[key].length < max) samples[key].push(label);
}

function hasFile(dir, work, name) {
  if (fs.existsSync(path.join(dir, name))) return true;
  if (name === "timing.json") return false;
  return !!(work && fs.existsSync(path.join(work.dir, name)));
}

for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  const work = song.workRef ? works.get(song.workRef) : null;
  const { body } = splitChordpro(fs.readFileSync(path.join(dir, "lyrics.chordpro"), "utf8"));
  const stanzas = body.split(/\r?\n\s*\r?\n/).map(b => b.split(/\r?\n/)).filter(st => st.some(l => l.trim()));
  const lyricStanzas = stanzas.filter(st => st.length >= 2);
  const chorded = lyricStanzas.filter(st => CHORD.test(st.slice(1).join("\n")));
  const anyChord = CHORD.test(body);
  const midi = hasFile(dir, work, "tune.mid");
  const abc = hasFile(dir, work, "tune.abc");
  const timing = fs.existsSync(path.join(dir, "timing.json"));
  const pdf = !!(song.uploads?.sheetPdf && fs.existsSync(path.join(dir, song.uploads.sheetPdf)));
  const label = `${langDir}/${section}/${folder}`;
  const partial = anyChord && lyricStanzas.length > 1 && chorded.length < lyricStanzas.length;

  buckets.total++;
  if (anyChord) buckets.hasChords++; else buckets.noChords++;
  if (partial) buckets.partialChords++;
  if (midi) buckets.midi++;
  if (midi && !timing) buckets.midiNoTiming++;
  if (timing) buckets.timing++;
  if (abc) buckets.abc++;
  if (abc && !midi) buckets.abcNoMidi++;
  if (pdf) buckets.pdf++;
  if (pdf && !anyChord) buckets.pdfNoChords++;
  if (midi && timing) buckets.playable++;
  if (anyChord && !partial) buckets.charted++;

  byLang[langDir] = (byLang[langDir] || 0) + 1;
  bySection[section] = (bySection[section] || 0) + 1;

  if (partial) pushSample("partialChords", `${label} (${chorded.length}/${lyricStanzas.length} stanzas)`);
  if (midi && !timing) pushSample("midiNoTiming", label);
  if (pdf && !anyChord) pushSample("pdfNoChords", label);
  if (abc && !midi) pushSample("abcNoMidi", label);
  if (!anyChord) pushSample("noChords", label);
}

const pct = (n) => buckets.total ? `${(100 * n / buckets.total).toFixed(1)}%` : "0%";
console.log(`songs ${buckets.total}  langs ${JSON.stringify(byLang)}  sections ${JSON.stringify(bySection)}`);
console.log(`chords     ${buckets.hasChords} (${pct(buckets.hasChords)})  fully charted ${buckets.charted}  partial ${buckets.partialChords}  none ${buckets.noChords}`);
console.log(`midi       ${buckets.midi} (${pct(buckets.midi)})  midi without karaoke ${buckets.midiNoTiming}`);
console.log(`karaoke    ${buckets.timing} (${pct(buckets.timing)})  midi+timing ${buckets.playable}`);
console.log(`abc        ${buckets.abc}  abc without midi ${buckets.abcNoMidi}`);
console.log(`sheetPdf   ${buckets.pdf}  pdf without chords ${buckets.pdfNoChords}`);
console.log("");
for (const [k, rows] of Object.entries(samples)) {
  if (!rows.length) continue;
  console.log(`${k} (${buckets[{ partialChords: "partialChords", midiNoTiming: "midiNoTiming", pdfNoChords: "pdfNoChords", abcNoMidi: "abcNoMidi", noChords: "noChords" }[k]] ?? rows.length}+):`);
  for (const r of rows) console.log(`  ${r}`);
  console.log("");
}
