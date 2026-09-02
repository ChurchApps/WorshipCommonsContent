// Finds hymns published twice under variant titles ("My Hope Is Built" vs
// "My Hope Is Built on Nothing Less") and links them as one work.
// Within a language, two songs are candidates when their normalized first
// lyric line is identical (strong — the same text), or when one normalized
// title is a prefix of the other and they share a writer surname (weak — the
// wrapping or the opening refrain differs, so a human has to read them).
// Prints a report and writes duplicate-groups.json (do not commit) with
// { canonical, duplicates[] } per group.
// --apply links first-line groups only: it sets workRef on the duplicates,
// creating works/<slug>/work.json in migrate-works.mjs's shape when no member
// has a work yet, and adopting into the existing work when one does. A member
// copy of a work asset that is byte-identical is deleted so the member
// inherits (validate errors otherwise); no song and no existing work's
// canonicalSongId is touched.
// Afterwards run: build-catalog → validate.
// Usage: node tools/find-duplicates.mjs [--apply]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { slugify, splitChordpro, songDirs, readJson, writeJson, readWorks } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const SHARED = ["tune.mid", "tune.abc", "art.webp"]; // work-level assets a member inherits

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
  const { body } = splitChordpro(fs.readFileSync(path.join(dir, "lyrics.chordpro"), "utf8"));
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
for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  if (song.submittedBy) continue; // user uploads are artist artifacts, not catalog duplicates
  songs.push({
    song, dir, langDir, folder,
    label: `songs/${langDir}/${section}/${folder}`,
    title: norm(song.title),
    first: norm(firstLyricLine(dir)),
    surnames: surnames(song.writer)
  });
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

// canonical = highest hymnalCount; tie → already has a workRef; tie → shorter folder name
const rank = (a, b) =>
  (b.song.hymnalCount ?? 0) - (a.song.hymnalCount ?? 0) ||
  (b.song.workRef ? 1 : 0) - (a.song.workRef ? 1 : 0) ||
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
  // already one work? nothing to propose
  if (list.every(s => s.song.workRef && s.song.workRef === list[0].song.workRef)) continue;
  list.sort(rank);
  const [canonical, ...duplicates] = list;
  const whyOf = d => reason.get([canonical.song.id, d.song.id].sort().join("|")) ?? "chained";
  groups.push({
    match: duplicates.every(d => whyOf(d) === "first-line") ? "first-line" : "title-prefix",
    canonical: { id: canonical.song.id, title: canonical.song.title, label: canonical.label, hymnalCount: canonical.song.hymnalCount ?? 0, workRef: canonical.song.workRef ?? null },
    duplicates: duplicates.map(d => ({ id: d.song.id, title: d.song.title, label: d.label, hymnalCount: d.song.hymnalCount ?? 0, workRef: d.song.workRef ?? null, match: whyOf(d) })),
    _songs: list
  });
}
groups.sort((a, b) => a.match.localeCompare(b.match) || a.canonical.title.localeCompare(b.canonical.title));

const works = readWorks(ROOT);
const workSlugs = new Set(works.keys());
const applied = [], skipped = [], s3rm = [];

for (const g of groups) {
  const line = `${g.canonical.title} [${g.canonical.label}]\n` +
    g.duplicates.map(d => `      + ${d.title} [${d.label}] (${d.match}, ${d.hymnalCount} hymnals)`).join("\n");
  if (g.match !== "first-line") { skipped.push(`REVIEW  ${line}`); continue; }

  // one work per group: adopt into the existing one (as migrate-works.mjs does),
  // create it from the canonical only when no member has a work yet
  const existing = [...new Set(g._songs.map(s => s.song.workRef).filter(Boolean))];
  if (existing.length > 1) { skipped.push(`CONFLICT ${line}\n      members already belong to different works: ${existing.join(", ")}`); continue; }

  const work = existing.length ? works.get(existing[0]) : null;
  applied.push(`LINK    ${line}` + (work
    ? `\n      → existing work ${work.slug}` + (work.canonicalSongId === g.canonical.id ? "" : ` (keeps its canonical ${work.canonicalSongId}; review by hand if it should be ${g.canonical.id})`)
    : ""));
  if (!APPLY) continue;

  let slug = existing[0];
  if (!slug) {
    slug = slugify(g.canonical.title);
    for (let n = 2; workSlugs.has(slug); n++) slug = `${slugify(g.canonical.title)}-${n}`;
    workSlugs.add(slug);
    fs.mkdirSync(path.join(ROOT, "works", slug), { recursive: true });
    writeJson(path.join(ROOT, "works", slug, "work.json"), { slug, title: g.canonical.title, canonicalSongId: g.canonical.id });
  }
  for (const s of g._songs) {
    if (s.song.workRef) continue;
    s.song.workRef = slug;
    delete s.song.parent; // parent is derived from the work
    writeJson(path.join(s.dir, "song.json"), s.song);
    // a member copy byte-identical to the work's asset must go — it inherits instead
    for (const f of SHARED) {
      const wp = path.join(ROOT, "works", slug, f), sp = path.join(s.dir, f);
      if (fs.existsSync(wp) && fs.existsSync(sp) && fs.readFileSync(sp).equals(fs.readFileSync(wp))) {
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
