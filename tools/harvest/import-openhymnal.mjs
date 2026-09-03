// Imports Open Hymnal Project ABC+MIDI that are public domain on the ABC `C:` line.
// Reworked from import-openhymnal.ts (retired src/seed-data/*.ts layout) to write
// songs/<lang>/public-domain/<slug>/ + song.json. Skips Dumont/Medcalf/Bird
// "freely reproduced for Christian worship, all other rights reserved" texts,
// colliding titles/ids, and files already in the 2014.06 corpus we previously imported.
//
// Usage: node tools/harvest/import-openhymnal.mjs <abc-dir>
// Optional sibling <abc-dir>/../midi-new/*.mid; otherwise fetches http://openhymnal.org/Midi/
// User-Agent: WorshipCommons content harvest (jeremy@zongker.net)
// Snapshot: http://openhymnal.org/Abc/ and OpenHymnal2014.06-abc.zip, 2026-09-03.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, LICENSES, slugify, renderChordpro, writeJson, songDirs, readJson } from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = "open-hymnal";
const SOURCE_URL = "http://openhymnal.org";
const UA = "WorshipCommons content harvest (jeremy@zongker.net)";
const DELAY_MS = 1000;
const PD_RE = /^(public domain|words, public domain\.\s*adaptation released into public domain|music and setting public domain\.$)/i;
const WORSHIP_ONLY_RE = /freely reproduced or published for christian worship|all other rights reserved/i;

const abcDir = process.argv[2];
if (!abcDir || !fs.existsSync(abcDir)) {
  console.error("Usage: node tools/harvest/import-openhymnal.mjs <abc-dir>");
  process.exit(1);
}
const midiDir = path.resolve(abcDir, "..", "midi-new");
fs.mkdirSync(midiDir, { recursive: true });

const { themes: VOCAB, synonyms } = readJson(path.join(ROOT, "themes.json"));
const canonical = new Set(VOCAB);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readText(p) {
  const buf = fs.readFileSync(p);
  const utf8 = buf.toString("utf8");
  return utf8.includes("\uFFFD") ? buf.toString("latin1") : utf8;
}

function parseName(raw) {
  const names = raw.split(";").map(n => {
    const clean = n.replace(/\(.*?\)/g, "").trim();
    if (!clean || /^(none|unknown|anonymous|traditional|american)$/i.test(clean)) return "";
    const m = clean.match(/^([^,]+),\s*(.+)$/);
    return m ? `${m[2].trim()} ${m[1].trim()}` : clean;
  }).filter(Boolean);
  return names.join(" & ");
}

function cleanLyric(l) {
  return l
    .replace(/^w:\s*/, "")
    .replace(/^\d+\.\s*~?\s*/, "")
    .replace(/!\w+!/g, "")
    .replace(/[*_|\\]/g, "")
    .replace(/~/g, " ")
    .replace(/([A-Za-z])-\s+/g, "$1")
    .replace(/([,.;:!?])-\s*/g, "$1 ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function mapThemes(topicsRaw) {
  const out = new Set();
  for (const m of topicsRaw.matchAll(/\{([^}]+)\}/g)) {
    const raw = decodeEntities(m[1]).replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
    if (!raw || raw.includes(",")) continue;
    if (canonical.has(raw)) { out.add(raw); continue; }
    if (!(raw in synonyms)) continue;
    const to = synonyms[raw];
    for (const t of to === null ? [] : Array.isArray(to) ? to : [to]) out.add(t);
  }
  return [...out].slice(0, 3).join(",");
}

function poeticMeter(raw) {
  const compact = raw.trim().replace(/\s+/g, ".");
  return /^(?:\d{1,2}(?:\.\d{1,2})+(?:[ .]D)?|[CLS]MD?)$/.test(compact) ? compact : null;
}

function parseAbc(file) {
  const text = readText(path.join(abcDir, file));
  const lines = text.split(/\r?\n/);
  const field = re => { const m = text.match(re); return m ? m[1].trim() : ""; };
  const title = field(/^T:\s*(.+)$/m);
  if (!title) return null;

  const copyright = field(/^C:\s*copyright:\s*(.+)$/im);
  const pd = PD_RE.test(copyright);
  const worshipOnly = WORSHIP_ONLY_RE.test(text);

  const author = parseName(field(/^%OHAUTHOR\s*(.+)$/m));
  const translator = parseName(field(/^%OHTRANSLATOR\s*(.+)$/m));
  const composer = parseName(field(/^%OHCOMPOSER\s*(.+)$/m));

  const wordsLine = field(/^C:\s*(Words:.+)$/m);
  const musicLine = field(/^C:\s*(Music:.+)$/m);
  const yearMatch = wordsLine.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/) || musicLine.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  const themes = mapThemes(field(/^%OHTOPICS\s*(.+)$/m));
  const scripture = field(/^%OHSCRIP\s*(.+)$/m).split(",")[0].trim() || null;
  const meter = poeticMeter(field(/^%OHMETRICAL\s*(.+)$/m));

  const keyRaw = field(/^K:\s*([^%\r\n]+)/m).trim();
  const km = keyRaw.match(/^([A-G][#b]?)\s*(m\b|min\w*)?/i);
  const key = km ? km[1] + (km[2] ? "m" : "") : "C";

  const meterRaw = field(/^M:\s*([^%\r\n]+)/m).trim();
  const timeSignature = /^\d+\/\d+$/.test(meterRaw) ? meterRaw : "4/4";

  const qm = text.match(/Q:\s*(\d+)\/(\d+)\s*=\s*(\d+)/);
  const bpm = qm
    ? Math.min(200, Math.max(40, Math.round(parseInt(qm[3], 10) * (parseInt(qm[1], 10) / parseInt(qm[2], 10)) * 4)))
    : 90;

  let melodyVoice = "";
  const stavesM = text.match(/%%staves\s*\(?\s*(\S+?)[\s)]/);
  if (stavesM) melodyVoice = stavesM[1];
  let current = "";
  const groups = [];
  let group = null;
  for (const l of lines) {
    const vm = l.match(/^\[V:\s*(\S+?)\]/);
    if (vm) {
      current = vm[1];
      if (!melodyVoice) melodyVoice = current;
      if (current === melodyVoice) { group = []; groups.push(group); }
      continue;
    }
    if (/^w:/.test(l) && current === melodyVoice && group) {
      const c = cleanLyric(l);
      if (c) group.push(c);
    }
  }
  const nonEmpty = groups.filter(g => g.length > 0);
  if (nonEmpty.length === 0) {
    return { file, title, author, translator, composer, year, themes, key, timeSignature, meter, bpm, scripture, pd, worshipOnly, stanzas: [] };
  }
  const verseCount = Math.max(...nonEmpty.map(g => g.length));
  const verses = Array.from({ length: verseCount }, () => []);
  const chorus = [];
  for (const g of nonEmpty) {
    if (g.length === verseCount) g.forEach((l, i) => verses[i].push(l));
    else g.forEach(l => chorus.push(l));
  }
  const stanzas = verses.filter(v => v.length > 0).map((v, i) => ({ label: `Verse ${i + 1}`, lines: v }));
  if (chorus.length > 0) stanzas.push({ label: "Chorus", lines: chorus });
  return { file, title, author, translator, composer, year, themes, key, timeSignature, meter, bpm, scripture, pd, worshipOnly, stanzas };
}

function norm(s) {
  return s.toLowerCase().replace(/['’,!()."?]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function variants(t) {
  const n = norm(t);
  return [n, n.replace(/^o /, "oh "), n.replace(/^oh /, "o "), n.replace(/\bye\b/g, "you"), n.replace(/\byou\b/g, "ye")];
}

const existingIds = new Set();
const existingFolders = new Set();
const existingNorm = new Map();
for (const { langDir, folder, dir } of songDirs(ROOT)) {
  existingFolders.add(`${langDir}/${folder}`);
  let song;
  try { song = readJson(path.join(dir, "song.json")); } catch { continue; }
  if (song.id) existingIds.add(song.id);
  if (song.title) for (const v of variants(song.title)) existingNorm.set(v, song.title);
}

function titleTaken(title) {
  const vars = variants(title);
  if (vars.some(v => existingNorm.has(v))) return existingNorm.get(vars.find(v => existingNorm.has(v)));
  const n = vars[0];
  for (const [en, orig] of existingNorm) {
    if (en.split(" ").filter(Boolean).length >= 3 && n.startsWith(en + " ")) return orig;
  }
  return null;
}

async function fetchMidi(abcFile) {
  const mid = abcFile.replace(/\.abc$/i, ".mid");
  const dest = path.join(midiDir, mid);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const url = `${SOURCE_URL}/Midi/${encodeURIComponent(mid)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  await sleep(DELAY_MS);
  return dest;
}

const abcFiles = fs.readdirSync(abcDir).filter(f => f.endsWith(".abc")).sort();
const skipped = [];
let imported = 0;
const seenTitle = new Set();

for (const file of abcFiles) {
  const p = parseAbc(file);
  if (!p) { skipped.push(`${file}: no title`); continue; }
  if (p.worshipOnly || !p.pd) { skipped.push(`${file}: ${p.worshipOnly ? "worship-only / all other rights reserved" : "C: not public domain"} (${p.title})`); continue; }
  if (p.stanzas.length === 0) { skipped.push(`${file}: no lyrics (${p.title})`); continue; }
  const id = idFor(p.title);
  const taken = titleTaken(p.title);
  if (taken) { skipped.push(`${file}: title already in catalog as "${taken}"`); continue; }
  if (existingIds.has(id)) { skipped.push(`${file}: id ${id} already exists (${p.title})`); continue; }
  const slug = slugify(p.title);
  const lang = "en";
  if (existingFolders.has(`${lang}/${slug}`)) { skipped.push(`${file}: folder songs/${lang}/public-domain/${slug} exists`); continue; }
  const titleKey = norm(p.title);
  if (seenTitle.has(titleKey)) { skipped.push(`${file}: duplicate title in this harvest (${p.title})`); continue; }

  const midiSrc = await fetchMidi(file);
  if (!midiSrc) { skipped.push(`${file}: MIDI missing (${p.title})`); continue; }

  const writer = [p.author || p.composer, p.translator && `tr. ${p.translator}`].filter(Boolean).join(" · ") || "Unknown";
  const body = p.stanzas.map(s => [s.label, ...s.lines].join("\n")).join("\n\n");
  const outDir = path.join(ROOT, "songs", lang, LICENSES.PD.section, slug);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(abcDir, file), path.join(outDir, "tune.abc"));
  fs.copyFileSync(midiSrc, path.join(outDir, "tune.mid"));

  const song = {
    id,
    title: p.title,
    writer,
    year: p.year,
    language: "English",
    themes: p.themes,
    key: p.key,
    bpm: p.bpm,
    timeSignature: p.timeSignature,
    ...(p.meter ? { meter: p.meter } : {}),
    scripture: p.scripture,
    license: "PD",
    licenseSource: SOURCE,
    churchCount: 0,
    hymnalCount: 0,
    provenance: { text: SOURCE, tune: SOURCE, abc: SOURCE }
  };
  writeJson(path.join(outDir, "song.json"), song);
  fs.writeFileSync(path.join(outDir, "lyrics.chordpro"), renderChordpro(song, body));
  seenTitle.add(titleKey);
  existingIds.add(id);
  existingFolders.add(`${lang}/${slug}`);
  for (const v of variants(p.title)) existingNorm.set(v, p.title);
  imported++;
  console.log(`IMPORT ${p.title}  (${file})`);
}

for (const s of skipped) console.warn(`SKIP  ${s}`);
console.log(`imported ${imported}; skipped ${skipped.length}. run write-sources-txt.mjs, build-catalog.mjs, validate.mjs`);
