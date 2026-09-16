// Finds hymns published twice under variant titles ("My Hope Is Built" vs
// "My Hope Is Built on Nothing Less") and links the duplicates to one parent.
// Within a language, two songs are candidates when their normalized first
// lyric line is identical (strong — the same text), or when one normalized
// title is a prefix of the other and they share a writer surname (weak — the
// wrapping or the opening refrain differs, so a human has to read them).
// Prints a report and writes duplicate-groups.json (do not commit) with
// { canonical, duplicates[] } per group.
// --apply links first-line groups only: it stamps parent: { id } on the duplicates
// (adopting into an existing family when a member already has a parent). A duplicate's
// copy of a shared asset that is byte-identical to the parent's is deleted so it
// inherits (validate errors otherwise); no existing parent link is touched.
// Afterwards run: build-catalog → validate.
// Usage: node tools/find-duplicates.mjs [--apply]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { splitChordpro, songDirs, writeJson, readSongRaw, readHarvested, lyricsPath, songJsonPath, SHARED_RELS, songIndex, orderSong } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const SHARED = SHARED_RELS; // parent assets a translation inherits

const ARTICLE = /^(?:the|a|an|el|la|los|las|un|una|der|die|das|den|dem|des|ein|eine|le|les|la|un|une|o|os|as|um|uma)\s+/;
// lowercase, apostrophes dropped, other punctuation → space, leading article off
const norm = s =>
  (s ?? "").normalize("NFC").toLowerCase()
    .replace(/['’ʼ]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(ARTICLE, "")
    .trim();

const SECTION_LABEL = /^(?:verse|chorus|refrain|bridge|coda|tag|intro|outro|ending|pre-?chorus|estrofa|coro|estribillo|strophe|kehrvers)\b/i;

// first sung line of the body: chords and directives stripped, section labels skipped
function firstLyricLine(dir) {
  const { body } = splitChordpro(fs.readFileSync(lyricsPath(dir), "utf8"));
  for (const line of body.split("\n")) {
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!text || text.startsWith("{") || text.startsWith("#") || SECTION_LABEL.test(text)) continue;
    return text;
  }
  return "";
}

// surnames = last word of each credited name ("Latin hymn · tr. Francis Pott" → hymn, pott)
const surnames = writer =>
  new Set(String(writer ?? "").split(/[,&·;/]|\band\b|\by\b|\bund\b/i)
    .map(part => norm(part).split(" ").filter(Boolean).pop())
    .filter(w => w && w.length > 2));

const songs = [];
for (const { langDir, folder, dir } of songDirs(ROOT)) {
  const song = readSongRaw(dir);
  if (song.submittedBy) continue; // user uploads are artist artifacts, not catalog duplicates
  const hymnalCount = readHarvested(dir).hymnalCount ?? song.hymnalCount ?? 0;
  songs.push({
    song, dir, langDir, folder, hymnalCount,
    label: `songs/${langDir}/${folder}`,
    title: norm(song.title),
    first: norm(firstLyricLine(dir)),
    surnames: surnames(song.writer)
  });
}
{
  const parents = new Set(songs.map(s => s.song.parent?.id).filter(Boolean));
  for (const s of songs) s.isParent = parents.has(s.song.id);
}

// candidate pairs → connected groups (union-find over the whole language)
const parent = new Map(songs.map(s => [s.song.id, s.song.id]));
const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
const reason = new Map(); // "idA|idB" → "first-line" | "title-prefix"
const link = (a, b, why) => {
  reason.set([a.song.id, b.song.id].sort().join("|"), why);
  parent.set(find(a.song.id), find(b.song.id));
};

const byLang = new Map();
for (const s of songs) { if (!byLang.has(s.langDir)) byLang.set(s.langDir, []); byLang.get(s.langDir).push(s); }
for (const list of byLang.values()) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.first && a.first === b.first) { link(a, b, "first-line"); continue; }
    if (!a.title || !b.title || a.title === b.title) continue;
    const prefix = a.title.startsWith(b.title + " ") || b.title.startsWith(a.title + " ");
    if (prefix && [...a.surnames].some(n => b.surnames.has(n))) link(a, b, "title-prefix");
  }
}

// canonical = highest hymnalCount; tie → already a parent; tie → shorter folder name
const rank = (a, b) =>
  (b.hymnalCount ?? 0) - (a.hymnalCount ?? 0) ||
  (b.isParent ? 1 : 0) - (a.isParent ? 1 : 0) ||
  a.folder.length - b.folder.length ||
  a.folder.localeCompare(b.folder);

const groups = [];
const members = new Map();
for (const s of songs) {
  const root = find(s.song.id);
  if (!members.has(root)) members.set(root, []);
  members.get(root).push(s);
}
for (const list of members.values()) {
  if (list.length < 2) continue;
  // already one family? nothing to propose
  const fam = s => s.song.parent?.id ?? s.song.id;
  if (list.every(s => fam(s) === fam(list[0]))) continue;
  list.sort(rank);
  const [canonical, ...duplicates] = list;
  const whyOf = d => reason.get([canonical.song.id, d.song.id].sort().join("|")) ?? "chained";
  groups.push({
    match: duplicates.every(d => whyOf(d) === "first-line") ? "first-line" : "title-prefix",
    canonical: { id: canonical.song.id, title: canonical.song.title, label: canonical.label, hymnalCount: canonical.hymnalCount ?? 0, parent: canonical.song.parent?.id ?? null },
    duplicates: duplicates.map(d => ({ id: d.song.id, title: d.song.title, label: d.label, hymnalCount: d.hymnalCount ?? 0, parent: d.song.parent?.id ?? null, match: whyOf(d) })),
    _songs: list
  });
}
groups.sort((a, b) => a.match.localeCompare(b.match) || a.canonical.title.localeCompare(b.canonical.title));

const index = songIndex(ROOT);
const applied = [], skipped = [], s3rm = [];

for (const g of groups) {
  const line = `${g.canonical.title} [${g.canonical.label}]\n` +
    g.duplicates.map(d => `      + ${d.title} [${d.label}] (${d.match}, ${d.hymnalCount} hymnals)`).join("\n");
  if (g.match !== "first-line") { skipped.push(`REVIEW  ${line}`); continue; }

  // one family per group: adopt into the existing one when a member already has a parent
  const existing = [...new Set(g._songs.map(s => s.song.parent?.id ?? (s.isParent ? s.song.id : null)).filter(Boolean))];
  if (existing.length > 1) { skipped.push(`CONFLICT ${line}
      members already belong to different families: ${existing.join(", ")}`); continue; }

  const parentId = existing[0] ?? g.canonical.id;
  applied.push(`LINK    ${line}` + (existing.length && parentId !== g.canonical.id
    ? `
      → existing family under ${parentId} (review by hand if it should be ${g.canonical.id})` : ""));
  if (!APPLY) continue;

  const parentDir = index.get(parentId).dir;
  for (const s of g._songs) {
    if (s.song.id === parentId || s.song.parent?.id) continue;
    s.song.parent = { id: parentId };
    writeJson(songJsonPath(s.dir), orderSong(s.song));
    // a copy byte-identical to the parent's asset must go — it inherits instead
    for (const f of SHARED) {
      const pp = path.join(parentDir, f), sp = path.join(s.dir, f);
      if (fs.existsSync(pp) && fs.existsSync(sp) && fs.readFileSync(sp).equals(fs.readFileSync(pp))) {
        fs.unlinkSync(sp);
        s3rm.push(`${s.label}/${f}`);
      }
    }
  }
}

for (const s of skipped) console.log(s);
for (const a of applied) console.log(a);
writeJson(path.join(ROOT, "duplicate-groups.json"),
  groups.map(({ _songs, ...g }) => g));
if (s3rm.length) {
  fs.writeFileSync(path.join(ROOT, "s3-cleanup.txt"), s3rm.map(k => `aws s3 rm s3://$BUCKET/${k}`).join("\n") + "\n");
  console.log(`s3-cleanup.txt: ${s3rm.length} stale bucket keys (optional cleanup; do not commit)`);
}
console.log(`${songs.length} songs compared: ${applied.length} same-first-line groups ${APPLY ? "linked" : "to link (rerun with --apply)"}, ` +
  `${skipped.length} left for review. duplicate-groups.json written (do not commit).`);
