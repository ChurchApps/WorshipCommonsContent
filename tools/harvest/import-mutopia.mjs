// Attaches Mutopia hymn-tagged SATB letter PDFs (CC-PDDC / public-domain typesetting)
// as sheetPdf on the matching English catalog song. Does not replace an existing
// tune.mid. The one CC-BY-SA-2.0 piece (Foundation) becomes its own catalog row —
// a PD hymn cannot absorb a ShareAlike score. Staging: .notes/harvest-staging/mutopia/.
// Usage: node tools/harvest/import-mutopia.mjs <staging-dir>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, LICENSES, slugify, renderChordpro, splitChordpro, writeJson, readJson } from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = "mutopia";
const stagingDir = process.argv[2];
if (!stagingDir || !fs.existsSync(stagingDir)) { console.error("Usage: node tools/harvest/import-mutopia.mjs <staging-dir>"); process.exit(1); }

const PD = [
  ["easter-hymn", "jesus-christ-is-risen-today", "https://www.mutopiaproject.org/ftp/Anonymous/Easter/"],
  ["leoni", "the-god-of-abraham-praise", "https://www.mutopiaproject.org/ftp/Anonymous/Leoni/"],
  ["old-100th-orig", "all-people-that-on-earth-do-dwell", "https://www.mutopiaproject.org/ftp/Anonymous/Old100-orig/"],
  ["new-britain", "amazing-grace", "https://www.mutopiaproject.org/ftp/Anonymous/new_britain/"],
  ["lobe-den-herren", "praise-to-the-lord-the-almighty", "https://www.mutopiaproject.org/ftp/Anonymous/lobe_den_Herren/"],
  ["ellacombe", "hosanna-loud-hosanna", "https://www.mutopiaproject.org/ftp/Anonymous/ellacombe/"],
  ["st-anne", "o-god-our-help-in-ages-past", "https://www.mutopiaproject.org/ftp/CroftW/st_anne/"],
  ["nicaea", "holy-holy-holy", "https://www.mutopiaproject.org/ftp/DykesJB/nicaea/"],
  ["melita", "eternal-father-strong-to-save", "https://www.mutopiaproject.org/ftp/DykesJB/melita/"],
  ["diademata", "crown-him-with-many-crowns", "https://www.mutopiaproject.org/ftp/ElveyGJ/Diademata/"],
  ["to-god-be-the-glory", "to-god-be-the-glory", "https://www.mutopiaproject.org/ftp/DoaneWH/ToGodBeTheGlory/"],
  ["woodworth", "just-as-i-am", "https://www.mutopiaproject.org/ftp/BradburyWB/woodworth/"],
  ["ville-de-havre", "it-is-well-with-my-soul", "https://www.mutopiaproject.org/ftp/BlissPP/villeduh/"],
  ["antioch", "joy-to-the-world", "https://www.mutopiaproject.org/ftp/HandelGF/antioch/"],
  ["stille-nacht", "silent-night", "https://www.mutopiaproject.org/ftp/GruberFX/stille_nacht/"],
  ["italian-hymn", "come-thou-almighty-king", "https://www.mutopiaproject.org/ftp/GiardiniFd/italian_hymn/"],
  ["cwm-rhondda", "guide-me-o-thou-great-jehovah", "https://www.mutopiaproject.org/ftp/HughesJ/CwmRhondda/"],
  ["eventide", "abide-with-me", "https://www.mutopiaproject.org/ftp/MonkWH/eventide/"],
  ["ein-feste-burg", "a-mighty-fortress-is-our-god", "https://www.mutopiaproject.org/ftp/LutherM/ein_feste_burg/"]
];

function letterPdf(dir) {
  return fs.readdirSync(dir).find(f => f.endsWith("-let.pdf") || f.endsWith(".pdf"));
}

let attached = 0;
for (const [folder, slug, url] of PD) {
  const srcDir = path.join(stagingDir, folder);
  const songDir = path.join(ROOT, "songs", "en", "public-domain", slug);
  if (!fs.existsSync(srcDir) || !fs.existsSync(songDir)) { console.warn(`SKIP  ${folder} → ${slug}: missing`); continue; }
  const pdf = letterPdf(srcDir);
  if (!pdf) { console.warn(`SKIP  ${folder}: no PDF`); continue; }
  const dest = path.join(songDir, "sheetPdf.pdf");
  if (fs.existsSync(dest)) { console.warn(`SKIP  ${slug}: already has sheetPdf.pdf`); continue; }
  fs.copyFileSync(path.join(srcDir, pdf), dest);
  const song = readJson(path.join(songDir, "song.json"));
  song.uploads = { ...(song.uploads || {}), sheetPdf: "sheetPdf.pdf" };
  writeJson(path.join(songDir, "song.json"), song);
  attached++;
  console.log(`PDF  ${slug} ← ${folder} (${url})`);
}

// Foundation is CC-BY-SA-2.0 typesetting of a PD text — own row, own license.
const fDir = path.join(stagingDir, "foundation");
const fPdf = fs.existsSync(fDir) && letterPdf(fDir);
const fMid = fDir && fs.readdirSync(fDir).find(f => f.endsWith(".mid"));
if (fPdf) {
  const title = "Foundation";
  const srcLyrics = path.join(ROOT, "songs", "en", "public-domain", "how-firm-a-foundation", "lyrics.chordpro");
  const { body } = splitChordpro(fs.readFileSync(srcLyrics, "utf8"));
  const outDir = path.join(ROOT, "songs", "en", LICENSES["CC-BY-SA"].section, slugify(title));
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(fDir, fPdf), path.join(outDir, "sheetPdf.pdf"));
  if (fMid) fs.copyFileSync(path.join(fDir, fMid), path.join(outDir, "tune.mid"));
  const song = {
    id: idFor(title),
    title,
    writer: "R. Keen · arr. Peter Chubb",
    year: 2005,
    language: "English",
    themes: "",
    key: "G",
    bpm: null,
    timeSignature: "4/4",
    meter: "11.11.11.11",
    scripture: null,
    license: "CC-BY-SA",
    licenseVersion: "2.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
    attribution: { required: true, text: "Peter Chubb / Mutopia Project", link: "https://www.mutopiaproject.org/ftp/Traditional/Foundation/" },
    churchCount: 0,
    hymnalCount: 0,
    provenance: { text: SOURCE, ...(fMid ? { tune: SOURCE } : {}) },
    uploads: { sheetPdf: "sheetPdf.pdf" }
  };
  writeJson(path.join(outDir, "song.json"), song);
  fs.writeFileSync(path.join(outDir, "lyrics.chordpro"), renderChordpro(song, body));
  console.log("NEW  foundation (CC-BY-SA 2.0 SATB)");
}

console.log(`attached ${attached} Mutopia SATB PDFs to existing PD songs; run write-sources-txt, build-catalog, validate`);
