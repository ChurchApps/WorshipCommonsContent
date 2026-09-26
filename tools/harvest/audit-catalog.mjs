// Per-package catalog audit. Plain Node; MIDI via audit-midi.py (mido); labels via sibling jev-trial.
//
//   node tools/harvest/audit-catalog.mjs --start-here --dry-run
//   node tools/harvest/audit-catalog.mjs --start-here --apply
//   node tools/harvest/audit-catalog.mjs --only amazing-grace --tasks verses,chordpro,midi,lyrics
//
// --apply writes safe fixes only (lyric chrome, empty key/bpm/time from the ChordPro
// header, a placeholder key / 4/4 from ABC K:/M: or an unambiguous MIDI, empty scripture from ABC %OHSCRIP, video.json on a high-confidence YouTube
// hit, labels when JEV is above the floor and --relabel or themes are empty).
// MIDI 120 / missing key-signature is a Cyber Hymnal sketch, not a reason to overwrite.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  songDirs, readJson, writeJson, readSong, readSongRaw, songJsonPath, lyricsPath,
  videoPath, analyticsPath, parseChordproStanzas, splitChordpro, stripChords,
  SECTION_LABEL, orderSong, writeManifest, idFromFolder, parentOf
} from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.PYTHON || "python";
const JEV_JUDGE = [
  path.resolve(ROOT, "..", "..", "jev-trial", "catalog-judge.mjs"),
  path.resolve(ROOT, "..", "jev-trial", "catalog-judge.mjs"),
].find(p => fs.existsSync(p));
const UA = "WorshipCommons content harvest (jeremy@zongker.net)";
const THEMES = new Set(readJson(path.join(ROOT, "themes.json")).themes);
const CALENDAR = new Set(["Advent", "Christmas", "Epiphany", "Lent", "Palm Sunday", "Easter", "Pentecost"]);
const SACRAMENT = new Set(["Baptism", "Communion"]);
const ALL_TASKS = ["verses", "chordpro", "midi", "scripture", "youtube", "lyrics", "labels"];
const NETWORK_TASKS = new Set(["youtube", "labels"]);
const CONFIDENCE_FLOOR = 0.7;

// Keep in sync with WorshipCommons/src/catalog.ts START_HERE_IDS.
const START_HERE_IDS = [
  "T0B8i41oasf", "b13IrZfZXWm", "ggzFvLEr9mK", "PcwqBQ0pxuT", "jY7zZ5DB4YC",
  "FMd8ryghVRb", "WE26JDTfHyQ", "5XkXjIIePgD", "_X94hS2ZTgf", "QnYa8cJdeLc",
  "DmZMgNX0L6p", "w5-RXH9uPli", "gspxyxVctNx", "3tR86sWVTNC", "Ft0nnpxQbbt",
  "Z8zZ1SBRMoo", "YxPfAFYWOaG", "2F9k4IkmoHX", "pSpS9dU7qHg", "GewWFBLDxRd",
  "XHeQW0SBedC", "erVpuKigTL9", "TtpzMXOT4AO", "0YyJoAE9Ge4", "Uo8aHwRz1ez",
  "wy7meh0qqDc", "_ALrpxFXZIG", "2zMeQ2kdb2n", "a19OdmA8uPt", "mp8_CK_E5qS",
  "MUIfLlOxrqc", "zfrKD0J-OPJ", "_UFqNA48X8n", "9jxQoj5H8ma", "DdnkGm4QMhD",
  "e0RA7WIC3mU", "sdbr4rHG9yR", "yumBImJYymh", "HLUq1nNdYTI", "efSPV6ob7E5",
];

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run") || !argv.includes("--apply");
const apply = argv.includes("--apply");
const relabel = argv.includes("--relabel");
const english = argv.includes("--english");
const startHere = argv.includes("--start-here");
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const tasksIdx = argv.indexOf("--tasks");
const requested = tasksIdx >= 0
  ? argv[tasksIdx + 1].split(",").map(s => s.trim()).filter(Boolean)
  : ALL_TASKS.filter(t => !NETWORK_TASKS.has(t));
const tasks = new Set(requested.filter(t => ALL_TASKS.includes(t)));

const CHROME_LINE = /^(?:words(?:\s*(?:,|&|and)\s*music)?(?:\s+by)?|music(?:\s+and\s+additional\s+words)?\s+by|lyrics by|written by|arranged by|copyright|©|\(c\)|\(p\)|ccli\b|ascap\b|used by permission|all rights reserved|line\s*\d+\s*:?$)/i;
const YT_REJECT = /\b(karaoke|backing track|instrumental(?! hymn)|tomlin|crowder|getty|hillsong|passion worship|my chains are gone|sermon|bible study|explained|reaction)\b/i;
const STOP = new Set(["a", "an", "the", "of", "in", "to", "and", "is", "o", "oh", "for", "my", "thy", "with"]);

const norm = s => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const alnum = s => norm(s).replace(/ /g, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function abcMeta(text) {
  const field = re => { const m = text.match(re); return m ? m[1].trim() : ""; };
  const keyRaw = field(/^K:\s*([^%\r\n]+)/m);
  // a mode other than major/minor (K:D dor) is not a key song.json can carry
  const km = keyRaw.match(/^([A-G][#b]?)\s*([A-Za-z]+(?!\s*=|[A-Za-z]))?/);
  const mode = (km?.[2] || "").toLowerCase();
  const key = km && /^(m|min\w*|aeo\w*|maj\w*|ion\w*)?$/.test(mode) ? km[1] + (/^(m$|min|aeo)/.test(mode) ? "m" : "") : null;
  // one meter for the whole tune, or none: a mid-tune M: change is not a time signature
  const meters = new Set([...text.matchAll(/(?:^|\[)M:\s*([^%\]\r\n]+)/gm)]
    .map(m => ({ C: "4/4", "C|": "2/2" })[m[1].trim()] || m[1].trim()));
  const meterRaw = meters.size === 1 ? [...meters][0] : "";
  const timeSignature = /^\d+\/\d+$/.test(meterRaw) ? meterRaw : null;
  const qm = text.match(/Q:\s*(\d+)\/(\d+)\s*=\s*(\d+)/);
  const bpm = qm
    ? Math.min(200, Math.max(40, Math.round(Number(qm[3]) * (Number(qm[1]) / Number(qm[2])) * 4)))
    : null;
  const underlaid = new Set([...text.matchAll(/^w:\s*(\d+)\./gm)].map(m => Number(m[1])));
  const extras = [...new Set([...text.matchAll(/^W:\s*(\d+)\./gm)].map(m => Number(m[1])))];
  const scripture = field(/^%OHSCRIP\s*(.+)$/m)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const firstW = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^w:\s*1\.\s*(.+)$/);
    if (m) firstW.push(m[1].replace(/[~*]/g, " ").replace(/\s+/g, " ").trim());
  }
  return { key, timeSignature, bpm, underlaid: [...underlaid].sort((a, b) => a - b), extras, scripture, firstVerse: firstW.join(" ") };
}

function chordIssues(body, song) {
  const issues = [];
  const stanzas = parseChordproStanzas(body);
  if (!stanzas.length) issues.push("no stanzas");
  const unlabeled = stanzas.filter(s => !s.label && s.lines.some(l => stripChords(l)));
  if (unlabeled.length === stanzas.length && stanzas.length > 1) issues.push("unlabeled stanzas");
  if (/^\[[^\]]*$/m.test(body) && /\[\s*$/m.test(body)) issues.push("unclosed chord bracket");
  const formLabels = (song.form?.sections || []).map(s => s.label);
  const bodyLabels = stanzas.map(s => s.label).filter(Boolean);
  if (formLabels.length && bodyLabels.length) {
    const missing = formLabels.filter(l => !bodyLabels.includes(l));
    if (missing.length) issues.push(`form labels missing from chart: ${missing.join(", ")}`);
  }
  return { issues, stanzas };
}

function isChromeLine(line, title) {
  const plain = stripChords(line);
  if (!plain) return false;
  if (SECTION_LABEL.test(plain)) return false;
  if (CHROME_LINE.test(plain)) return true;
  if (/^(?:line|verse)\s*\d+\s*:?$/i.test(plain)) return true;
  const a = alnum(plain), b = alnum(title);
  if (b && a === b) return false;
  return false;
}

function stripChrome(body, title) {
  const stanzas = [];
  let cur = [];
  const push = () => { if (cur.length) stanzas.push(cur); cur = []; };
  for (const line of body.split("\n")) {
    if (!line.trim()) { push(); continue; }
    cur.push(line);
  }
  push();
  let dropped = 0;
  const kept = [];
  for (const st of stanzas) {
    const lines = st.filter(l => l.trim() && !isChromeLine(l, title));
    if (!lines.length) { dropped++; continue; }
    if (lines.every(l => { const p = stripChords(l); return SECTION_LABEL.test(p) || !p; })) {
      dropped++;
      continue;
    }
    kept.push(st.filter(l => !isChromeLine(l, title) || SECTION_LABEL.test(stripChords(l))));
  }
  return { body: kept.map(st => st.join("\n")).join("\n\n"), dropped };
}

const BOOK_ABBR = {
  jn: "john", joh: "john", lk: "luke", lu: "luke", mt: "matthew", mk: "mark",
  ps: "psalm", psa: "psalm", rom: "romans", cor: "corinthians", sam: "samuel",
  eph: "ephesians", gal: "galatians", isa: "isaiah", rev: "revelation",
  gen: "genesis", ex: "exodus", dt: "deuteronomy", heb: "hebrews",
  phil: "philippians", col: "colossians", thess: "thessalonians",
  tim: "timothy", pet: "peter", act: "acts",
};
function canonRef(s) {
  const t = String(s || "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(\d+\s*)?([a-z]+)\s*(\d+)(?::(\d+))?(?:\s*-\s*(\d+))?/);
  if (!m) return t;
  const book = BOOK_ABBR[m[2]] || m[2];
  return `${m[1] || ""}${book} ${m[3]}${m[4] ? ":" + m[4] : ""}`;
}
function samePassage(a, b) {
  const ca = canonRef(a), cb = canonRef(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const bookCh = s => s.replace(/:\d+$/, "");
  return bookCh(ca) === bookCh(cb) || ca.startsWith(cb) || cb.startsWith(ca);
}

function estimateSeconds(song, stanzas) {
  const bpm = Number(song.bpm);
  const beats = Number(String(song.timeSignature || "4/4").split("/")[0]) || 4;
  const lines = stanzas.reduce((n, st) => n + st.lines.filter(l => stripChords(l)).length, 0);
  if (!bpm || !lines) return null;
  return Math.round(lines * beats * (60 / bpm));
}

function capLabels(tags) {
  const out = [];
  for (const t of tags) {
    if (!t || t === "none" || !THEMES.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  if (out.includes("Praise") && out.includes("Adoration") && out.length > 3) {
    out.splice(out.indexOf("Praise"), 1);
  }
  if (out.length <= 3) return out;
  const cal = out.some(t => CALENDAR.has(t));
  const sac = out.some(t => SACRAMENT.has(t));
  if (cal && sac && out.length === 4) return out;
  return out.slice(0, 3);
}

function pickSongs() {
  const want = startHere ? new Set(START_HERE_IDS) : null;
  const rows = [];
  for (const e of songDirs(ROOT)) {
    const id = idFromFolder(e.folder);
    if (only && e.folder !== only && !e.folder.includes(only) && id !== only) continue;
    if (want && !want.has(id)) continue;
    const song = readSong(e.dir);
    if (english && song.language !== "English") continue;
    rows.push({ ...e, id, song });
  }
  return rows;
}

function midiProbe(paths) {
  if (!paths.length) return new Map();
  const py = path.join(path.dirname(fileURLToPath(import.meta.url)), "audit-midi.py");
  const r = spawnSync(PYTHON, [py], { input: JSON.stringify(paths), encoding: "utf8", maxBuffer: 20_000_000 });
  if (r.status !== 0) {
    console.error("audit-midi.py failed:", (r.stderr || r.stdout || "").slice(0, 400));
    return new Map();
  }
  try {
    return new Map((JSON.parse(r.stdout || "[]")).map(row => [row.path, row]));
  } catch {
    return new Map();
  }
}

function jevJudgeChunk(task, items) {
  const r = spawnSync(process.execPath, [JEV_JUDGE], {
    input: JSON.stringify({ task, items }),
    encoding: "utf8",
    maxBuffer: 20_000_000,
    cwd: path.dirname(JEV_JUDGE),
  });
  if (r.status !== 0) {
    console.error("catalog-judge failed:", (r.stderr || r.stdout || "").slice(0, 500));
    return items.map(it => ({ id: it.id, error: (r.stderr || "judge failed").slice(0, 200) }));
  }
  try { return JSON.parse(r.stdout); }
  catch { return items.map(it => ({ id: it.id, error: "judge json" })); }
}

function jevJudge(task, items) {
  if (!items.length) return [];
  if (!JEV_JUDGE) {
    console.error("skip %s: jev-trial/catalog-judge.mjs not found", task);
    return items.map(it => ({ id: it.id, skipped: "no-jev" }));
  }
  const out = [];
  const size = 40;
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    console.log(`${task} ${i + 1}-${i + chunk.length}/${items.length}`);
    out.push(...jevJudgeChunk(task, chunk));
  }
  return out;
}

function ytCandidates(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/"videoRenderer":\{"videoId":"([\w-]{11})"/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const slice = html.slice(m.index, (m.index || 0) + 3000);
    const t = slice.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    if (t) {
      try { out.push({ id: m[1], title: JSON.parse(`"${t[1]}"`) }); }
      catch { /* skip */ }
    }
    if (out.length >= 8) break;
  }
  return out;
}

async function fetchRetry(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "user-agent": UA, cookie: "CONSENT=YES+1" } });
      if (resp.status !== 429) return resp;
      throw new Error("HTTP 429");
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(15_000 * (attempt + 1));
    }
  }
}

async function pickVideo(title, writer) {
  const q = encodeURIComponent(`"${title}" ${writer || ""} hymn`);
  const resp = await fetchRetry(`https://www.youtube.com/results?search_query=${q}&sp=EgIQAQ%253D%253D`);
  if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);
  const html = await resp.text();
  const words = norm(title).split(" ").filter(w => w && !STOP.has(w));
  const need = Math.ceil(words.length * 0.8);
  for (const c of ytCandidates(html)) {
    if (YT_REJECT.test(c.title)) continue;
    const matched = words.filter(w => norm(c.title).includes(w)).length;
    if (matched < need) continue;
    const oe = await fetchRetry(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${c.id}&format=json`);
    if (!oe.ok) continue;
    return { youtube: c.id, title: c.title };
  }
  return null;
}

function writeAnalytics(dir, patch) {
  const file = analyticsPath(dir);
  const prev = fs.existsSync(file) ? readJson(file) : {};
  const next = { ...prev, ...patch, checkedAt: new Date().toISOString().slice(0, 10) };
  if (!dryRun) {
    writeJson(file, next);
    writeManifest(dir);
  }
  return next;
}

// {name: value} in the ChordPro header (validate: key/time/tempo must equal song.json)
function setDirective(text, name, value) {
  const lines = text.split("\n");
  let end = 0;
  while (end < lines.length && lines[end].startsWith("{")) end++;
  const line = `{${name}: ${value}}`;
  const at = lines.slice(0, end).findIndex(l => l.startsWith(`{${name}:`));
  if (at >= 0) lines[at] = line;
  else lines.splice(end, 0, ...(end ? [line] : [line, ""]));
  return lines.join("\n");
}

function writeSongFile(dir, song) {
  writeJson(songJsonPath(dir), orderSong(song));
}

const packages = pickSongs();
console.log(`${packages.length} packages  tasks ${[...tasks].join(",")}  ${apply ? "apply" : "dry-run"}`);

const midiPaths = [];
if (tasks.has("midi")) {
  for (const p of packages) {
    const mid = path.join(p.dir, "sources", "tune.mid");
    if (fs.existsSync(mid)) midiPaths.push(mid);
  }
}
const midiByPath = tasks.has("midi") ? midiProbe(midiPaths) : new Map();

const report = [];
const changed = [];
const labelItems = [];
const scriptureItems = [];

let n = 0;
for (const pkg of packages) {
  n++;
  if (n === 1 || n % 50 === 0 || n === packages.length) console.log(`scan ${n}/${packages.length}`);
  const { dir, song, id, langDir, folder } = pkg;
  const label = `songs/${langDir}/${folder}`;
  const raw = readSongRaw(dir);
  const lyricsFile = lyricsPath(dir);
  const chordpro = fs.existsSync(lyricsFile) ? fs.readFileSync(lyricsFile, "utf8") : "";
  const { header, body } = chordpro ? splitChordpro(chordpro) : { header: {}, body: "" };
  const abcFile = path.join(dir, "sources", "tune.abc");
  const abc = fs.existsSync(abcFile) ? abcMeta(fs.readFileSync(abcFile, "utf8")) : null;
  const parent = parentOf(ROOT, song);
  const parentAbcFile = parent ? path.join(parent.dir, "sources", "tune.abc") : null;
  const abcUse = abc || (parentAbcFile && fs.existsSync(parentAbcFile) ? abcMeta(fs.readFileSync(parentAbcFile, "utf8")) : null);
  const row = { id, title: song.title, path: label, actions: [], notes: {} };
  let songDirty = false;
  let lyricsDirty = false;
  let nextBody = body;
  const directives = {}; // ChordPro header lines to match what song.json was given

  if (tasks.has("chordpro")) {
    const { issues, stanzas } = chordIssues(body, song);
    row.notes.chordpro = { ok: issues.length === 0, issues, stanzas: stanzas.length };
    if (header.key && song.key && header.key !== String(song.key))
      issues.push(`{key: ${header.key}} != song.json ${song.key}`);
    if (header.tempo && song.bpm && String(header.tempo) !== String(song.bpm))
      issues.push(`{tempo: ${header.tempo}} != song.json ${song.bpm}`);
    if (header.time && song.timeSignature && header.time !== String(song.timeSignature))
      issues.push(`{time: ${header.time}} != song.json ${song.timeSignature}`);
    row.notes.chordpro.issues = issues;
    row.notes.chordpro.ok = issues.length === 0;
  }

  if (tasks.has("verses")) {
    const stanzas = parseChordproStanzas(body).filter(s => s.lines.some(l => stripChords(l)));
    const have = stanzas.length;
    const underlaid = abcUse?.underlaid?.length || 0;
    const extras = abcUse?.extras || [];
    const v1 = alnum(stanzas[0] ? stanzas[0].lines.map(stripChords).join(" ") : "");
    const abcV1 = alnum(abcUse?.firstVerse || "");
    const firstMatch = !abcV1 || !v1 || v1.slice(0, 40) === abcV1.slice(0, 40) || v1.includes(abcV1.slice(0, 24)) || abcV1.includes(v1.slice(0, 24));
    const missing = song.license === "PD" && underlaid > have && firstMatch;
    row.notes.verses = {
      have,
      abcUnderlaid: underlaid,
      abcExtra: extras,
      firstVerseMatchesAbc: firstMatch,
      missing,
      hint: missing ? "python tools/harvest/backfill-library-chords.py --expand --only " + folder.replace(/-[^-]{11}$/, "").replace(/-$/, "") : null,
    };
    if (!firstMatch && underlaid > have) row.notes.verses.skipped = "first verse does not match ABC (borrowed tune?)";
  }

  if (tasks.has("lyrics")) {
    const stripped = stripChrome(body, song.title);
    row.notes.lyrics = { chromeStanzas: stripped.dropped };
    if (stripped.dropped && stripped.body.trim() && stripped.body !== body) {
      row.actions.push(`drop ${stripped.dropped} chrome stanza(s)`);
      if (apply) { nextBody = stripped.body; lyricsDirty = true; }
    }
  }

  if (tasks.has("midi")) {
    const mid = path.join(dir, "sources", "tune.mid");
    const probed = midiByPath.get(mid) || null;
    const stanzas = parseChordproStanzas(nextBody);
    const est = estimateSeconds(song, stanzas);
    const timingFile = path.join(dir, "sources", "timing.json");
    const timing = fs.existsSync(timingFile) ? readJson(timingFile) : null;
    const chartKey = raw.key || header.key || null;
    const chartBpm = raw.bpm || (header.tempo ? Number(header.tempo) : null) || null;
    const chartTime = raw.timeSignature || header.time || null;
    const notes = {
      song: { key: chartKey, bpm: chartBpm, timeSignature: chartTime },
      abc: abcUse ? { key: abcUse.key, bpm: abcUse.bpm, timeSignature: abcUse.timeSignature } : null,
      midi: probed,
      duration: { timing: timing?.duration ?? null, estimate: est, midiSeconds: probed?.seconds ?? null },
      fill: {},
    };
    // a placeholder is what an import writes when it knows nothing: no key, the "4/4" default
    const current = field => notes.fill[field]?.value ?? raw[field];
    const isPlaceholder = (field, v) => v == null || v === "" || (field === "timeSignature" && String(v) === "4/4");
    const fill = (field, value, source, overPlaceholder = false) => {
      const have = current(field);
      if (overPlaceholder ? !isPlaceholder(field, have) : have != null && have !== "") return;
      if (value == null || value === "" || String(value) === String(have ?? "")) return;
      // Translations inherit key/bpm/time; stamping the same value is a validate warning.
      if (raw.parent?.id && ["key", "bpm", "timeSignature", "meter", "tune"].includes(field)) return;
      notes.fill[field] = { value, source };
      row.actions.push(`fill ${field}=${value} from ${source}`);
      if (apply) {
        raw[field] = value; songDirty = true;
        const directive = { key: "key", timeSignature: "time", bpm: "tempo" }[field];
        if (directive) directives[directive] = value;
      }
    };
    const fillIfEmpty = (field, value, source) => fill(field, value, source);
    // This package's chart header is the congregational key/tempo.
    fillIfEmpty("key", header.key, "chordpro");
    fillIfEmpty("timeSignature", header.time, "chordpro");
    fillIfEmpty("bpm", header.tempo ? Number(header.tempo) : null, "chordpro");
    // A placeholder key/time gives way to the tune: ABC K:/M: win, else a MIDI with a single
    // time signature, and a single key signature its notes fit (>= 90% diatonic). PD songs
    // too: only the tempo of a PD (Cyber Hymnal) MIDI is the sequencer's, not the hymn's.
    const midiKey = probed?.keys?.length === 1 && probed.diatonic >= 0.9 ? probed.keys[0].replace(/maj$/i, "") : null;
    const midiTime = probed?.times?.length === 1 ? probed.times[0] : null;
    fill("key", abcUse?.key || midiKey, abcUse?.key ? "abc" : "midi", true);
    fill("timeSignature", abcUse?.timeSignature || midiTime, abcUse?.timeSignature ? "abc" : "midi", true);
    if (!header.tempo && probed?.bpm && probed.bpm !== 120 && !abcUse && song.license !== "PD")
      fillIfEmpty("bpm", probed.bpm, "midi");
    const midiBpm = probed?.bpm;
    if (midiBpm && chartBpm && Math.abs(midiBpm - Number(chartBpm)) > 5 && midiBpm !== 120)
      notes.drift = [...(notes.drift || []), `bpm midi ${midiBpm} vs chart ${chartBpm}`];
    if (probed?.time && chartTime && probed.time !== String(chartTime))
      notes.drift = [...(notes.drift || []), `time midi ${probed.time} vs chart ${chartTime}`];
    if (probed?.key && chartKey && probed.key.replace(/maj$/i, "") !== String(chartKey))
      notes.drift = [...(notes.drift || []), `key midi ${probed.key} vs chart ${chartKey}`];
    if (probed?.seconds && est && probed.seconds * 2 < est)
      notes.drift = [...(notes.drift || []), `midi ${probed.seconds}s looks like fewer verses than chart (~${est}s)`];
    row.notes.midi = notes;
  }

  if (tasks.has("scripture")) {
    const refs = abcUse?.scripture || [];
    const have = song.scripture ? String(song.scripture).trim() : "";
    row.notes.scripture = { have: have || null, abc: refs };
    if (!have && refs[0] && song.license === "PD") {
      row.actions.push(`fill scripture=${refs[0]} from ABC %OHSCRIP`);
      if (apply) { raw.scripture = refs[0]; songDirty = true; }
    }
    const extraRefs = refs.filter(r => {
      if (!have) return r !== refs[0];
      return !samePassage(have, r);
    });
    if (extraRefs.length) {
      row.notes.scripture.candidates = extraRefs;
      const lyrics = stripChords(nextBody).replace(/\{[^}]*\}/g, "").trim();
      for (const ref of extraRefs.slice(0, 3)) {
        scriptureItems.push({ id, title: song.title, lyrics, ref, dir, label });
      }
    }
  }

  if (tasks.has("youtube")) {
    const vf = videoPath(dir);
    const have = fs.existsSync(vf) ? readJson(vf) : null;
    row.notes.youtube = have?.youtube ? { have: true, youtube: have.youtube, title: have.title } : { have: false };
  }

  if (tasks.has("labels")) {
    const lyrics = nextBody.replace(/\[[^\]]*\]/g, "").replace(/\{[^}]*\}/g, "").trim();
    row.notes.labels = { current: raw.themes || song.themes || null };
    if (lyrics) labelItems.push({
      id, title: song.title, writer: song.writer, themes: raw.themes || song.themes || "", lyrics, dir, raw, label,
      canWrite: !raw.parent?.id && (relabel || !(raw.themes && String(raw.themes).trim())),
    });
  }

  if ((lyricsDirty || Object.keys(directives).length) && apply && chordpro) {
    const origBody = splitChordpro(chordpro).body;
    const idx = chordpro.indexOf(origBody);
    let text = !lyricsDirty ? chordpro : idx >= 0
      ? chordpro.slice(0, idx) + nextBody.replace(/\n+$/, "") + "\n"
      : nextBody.replace(/\n+$/, "") + "\n";
    for (const [name, value] of Object.entries(directives)) text = setDirective(text, name, value);
    if (text !== chordpro) {
      fs.writeFileSync(lyricsFile, text);
      writeManifest(dir);
      changed.push(label + " lyrics");
    }
  }
  if (songDirty && apply) {
    writeSongFile(dir, raw);
    changed.push(label + " song.json");
  }
  if (row.actions.length || Object.keys(row.notes).length) report.push(row);
}

if (tasks.has("labels") && labelItems.length) {
  console.log(`JEV labels: ${labelItems.length} songs`);
  const judged = jevJudge("labels", labelItems.map(({ id, title, writer, themes, lyrics }) => ({ id, title, writer, themes, lyrics })));
  const byId = new Map(judged.map(j => [j.id, j]));
  for (const item of labelItems) {
    const j = byId.get(item.id);
    const rec = report.find(r => r.id === item.id);
    if (!rec) continue;
    if (!j || j.error || j.skipped) {
      rec.notes.labels = { ...rec.notes.labels, ...(j || { skipped: true }) };
      continue;
    }
    const picks = [];
    const confs = [];
    for (const slot of ["primary", "secondary", "tertiary"]) {
      const val = j[slot];
      const conf = j.confidence?.[slot];
      if (val && val !== "none" && (conf == null || conf >= CONFIDENCE_FLOOR)) {
        picks.push(val);
        confs.push(conf);
      }
    }
    if (j.kids === true && (j.confidence?.kids == null || j.confidence.kids >= CONFIDENCE_FLOOR)) picks.push("Kids");
    const tags = capLabels(picks);
    rec.notes.labels = { ...rec.notes.labels, proposed: tags, confidence: confs, raw: j };
    if (!tags.length) continue;
    if (!item.canWrite) {
      rec.notes.labels.skipped = "already tagged; pass --relabel to overwrite";
      continue;
    }
    rec.actions.push(`themes=${tags.join(",")}`);
    if (apply) {
      const song = readSongRaw(item.dir);
      song.themes = tags.join(",");
      writeSongFile(item.dir, song);
      changed.push(rec.path + " themes");
    }
  }
}

if (tasks.has("scripture") && scriptureItems.length && fs.existsSync(JEV_JUDGE)) {
  console.log(`JEV scripture: ${scriptureItems.length} candidate refs`);
  const judged = jevJudge("scripture", scriptureItems.map(({ id, title, lyrics, ref }) => ({ id, title, lyrics, ref })));
  const extrasById = new Map();
  for (const j of judged) {
    if (j.match === true && (j.confidence == null || j.confidence >= CONFIDENCE_FLOOR)) {
      const rec = report.find(r => r.id === j.id);
      if (rec) {
        rec.notes.scripture = rec.notes.scripture || {};
        rec.notes.scripture.extra = [...(rec.notes.scripture.extra || []), { ref: j.ref, confidence: j.confidence }];
        rec.actions.push(`related verse ${j.ref}`);
      }
      const list = extrasById.get(j.id) || [];
      list.push({ ref: j.ref, confidence: j.confidence });
      extrasById.set(j.id, list);
    }
  }
  if (apply) {
    for (const [id, extras] of extrasById) {
      const pkg = packages.find(p => p.id === id);
      if (!pkg) continue;
      writeAnalytics(pkg.dir, { versesRelated: extras });
    }
  }
}

if (tasks.has("youtube")) {
  const missing = packages.filter(p => !fs.existsSync(videoPath(p.dir)));
  console.log(`YouTube: ${missing.length} without video.json`);
  for (const pkg of missing) {
    const rec = report.find(r => r.id === pkg.id) || { id: pkg.id, title: pkg.song.title, path: `songs/${pkg.langDir}/${pkg.folder}`, actions: [], notes: {} };
    if (!report.includes(rec)) report.push(rec);
    try {
      const hit = await pickVideo(pkg.song.title, pkg.song.writer);
      rec.notes.youtube = hit ? { have: false, candidate: hit } : { have: false, candidate: null };
      if (hit) {
        rec.actions.push(`video ${hit.youtube} (${hit.title})`);
        if (apply) {
          writeJson(videoPath(pkg.dir), hit);
          writeManifest(pkg.dir);
          changed.push(rec.path + " video.json");
        }
      }
    } catch (e) {
      rec.notes.youtube = { have: false, error: String(e.message || e).slice(0, 200) };
    }
    await sleep(2500);
  }
}

for (const rec of report) {
  if (!apply) continue;
  const pkg = packages.find(p => p.id === rec.id);
  if (!pkg) continue;
  const patch = {};
  if (rec.notes.verses) patch.verses = rec.notes.verses;
  if (rec.notes.midi) patch.midi = { drift: rec.notes.midi.drift || [], fill: rec.notes.midi.fill || {} };
  if (rec.notes.labels?.proposed) patch.labels = { proposed: rec.notes.labels.proposed, confidence: rec.notes.labels.confidence };
  if (rec.notes.chordpro) patch.chordpro = rec.notes.chordpro;
  if (Object.keys(patch).length) writeAnalytics(pkg.dir, patch);
}

const outFile = path.join(ROOT, "tools", "harvest", "audit-report.json");
writeJson(outFile, {
  at: new Date().toISOString(),
  apply,
  tasks: [...tasks],
  packages: packages.length,
  changed,
  rows: report,
});
const flagged = report.filter(r => (r.notes.verses?.missing) || (r.notes.lyrics?.chromeStanzas) || (r.notes.midi?.drift?.length) || (r.notes.chordpro && !r.notes.chordpro.ok) || (r.actions.length));
console.log(`report ${outFile}`);
console.log(`${report.length} rows, ${flagged.length} with findings, ${changed.length} writes`);
for (const r of flagged.slice(0, 40)) {
  const bits = [];
  if (r.notes.verses?.missing) bits.push(`verses ${r.notes.verses.have}/${r.notes.verses.abcUnderlaid}`);
  if (r.notes.lyrics?.chromeStanzas) bits.push(`chrome ${r.notes.lyrics.chromeStanzas}`);
  if (r.notes.midi?.drift?.length) bits.push(r.notes.midi.drift.join("; "));
  if (r.actions.length) bits.push(r.actions.join("; "));
  console.log(`  ${r.title}: ${bits.join(" | ")}`);
}
if (flagged.length > 40) console.log(`  … ${flagged.length - 40} more`);
