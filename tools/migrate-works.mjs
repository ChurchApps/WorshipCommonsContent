// One-shot (but rerunnable) migration: groups parent-linked translation families
// under works/<slug>/, moves the canonical's shared assets (tune.mid/tune.abc/
// art.webp) into the work folder, deletes byte-identical member copies, and
// rewrites member song.json files (workRef added, parent removed).
// Families whose members already have workRef are skipped, so reruns are no-ops
// and this doubles as the tool for later CANONICAL_OVERRIDES additions.
// Afterwards run: write-sources-txt → build-catalog → validate.
// Usage: node tools/migrate-works.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { slugify, songDirs, readJson, writeJson } from "./lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = ["tune.mid", "tune.abc", "art.webp"];

// current top-level parent id → true original-language song id. Only these
// families are flipped; every other "original"-labeled child is reported below
// for review (the labels are unreliable — some translations claim "original").
const CANONICAL_OVERRIDES = {
  DdnkGm4QMhD: "CmGjWnGTSVW", // Silent Night → Stille Nacht
  "9jxQoj5H8ma": "hL6IUnDadWy", // A Mighty Fortress → Ein feste Burg ist unser Gott
  e0RA7WIC3mU: "yGo9po6GLcI" // O Come, All Ye Faithful → Adeste Fideles
};

// load every song with its folder
const songs = new Map(); // id → { song, dir, label }
for (const { section, langDir, folder, dir } of songDirs(ROOT)) {
  const song = readJson(path.join(dir, "song.json"));
  songs.set(song.id, { song, dir, label: `songs/${langDir}/${section}/${folder}` });
}

// build families keyed by root id, merging chains (grandchildren collapse)
const rootOf = id => {
  const seen = new Set();
  while (songs.get(id)?.song.parent?.id && songs.has(songs.get(id).song.parent.id)) {
    if (seen.has(id)) throw new Error(`parent cycle at ${id}`);
    seen.add(id);
    id = songs.get(id).song.parent.id;
  }
  return id;
};
const families = new Map(); // root id → Set of member ids (root included)
for (const [id, { song, label }] of songs) {
  if (!song.parent?.id) continue;
  if (!songs.has(song.parent.id)) { console.warn(`SKIP  ${label}: parent ${song.parent.id} not in catalog`); continue; }
  const root = rootOf(id);
  if (!families.has(root)) families.set(root, new Set([root]));
  families.get(root).add(id);
}

const stats = { works: 0, moved: 0, deleted: 0, rewritten: 0, skipped: 0 };
const s3rm = [];
const workSlugs = new Set(fs.existsSync(path.join(ROOT, "works")) ? fs.readdirSync(path.join(ROOT, "works")) : []);

for (const [rootId, memberIds] of families) {
  const canonicalId = CANONICAL_OVERRIDES[rootId] ?? rootId;
  if (!memberIds.has(canonicalId)) throw new Error(`override ${rootId} → ${canonicalId}: not a family member`);
  const canonical = songs.get(canonicalId);
  if ([...memberIds].every(id => songs.get(id).song.workRef)) { stats.skipped++; continue; } // fully migrated

  // a newly harvested member may point its parent into an already-migrated family:
  // adopt it into the existing work instead of creating a second one
  let slug = [...memberIds].map(id => songs.get(id).song.workRef).find(Boolean);
  let workDir = slug ? path.join(ROOT, "works", slug) : null;
  if (!slug) {
    // slug from canonical title; suffix on collision (distinct hymns can share a title)
    slug = slugify(canonical.song.title);
    for (let n = 2; workSlugs.has(slug); n++) slug = `${slugify(canonical.song.title)}-${n}`;
    workSlugs.add(slug);
    workDir = path.join(ROOT, "works", slug);
    fs.mkdirSync(workDir, { recursive: true });
    writeJson(path.join(workDir, "work.json"), { slug, title: canonical.song.title, canonicalSongId: canonicalId });
    stats.works++;
    // canonical's shared assets move to the work
    for (const f of SHARED) {
      const src = path.join(canonical.dir, f);
      if (fs.existsSync(src)) { fs.renameSync(src, path.join(workDir, f)); stats.moved++; }
    }
  }

  // byte-identical member copies of the work's assets are deleted
  for (const f of SHARED) {
    const workFile = path.join(workDir, f);
    if (!fs.existsSync(workFile)) continue;
    const workBytes = fs.readFileSync(workFile);
    for (const id of memberIds) {
      const { dir, label } = songs.get(id);
      const p = path.join(dir, f);
      if (fs.existsSync(p) && fs.readFileSync(p).equals(workBytes)) {
        fs.unlinkSync(p);
        s3rm.push(`${label}/${f}`);
        stats.deleted++;
      }
    }
  }

  // rewrite members: workRef in, parent out; fix labels on flipped families
  for (const id of memberIds) {
    const { song, dir } = songs.get(id);
    if (song.workRef) continue; // already a member (adoption run)
    song.workRef = slug;
    delete song.parent;
    if (canonicalId !== rootId) {
      if (id === canonicalId) delete song.relationLabel; // was "German original · …"
      if (id === rootId) song.relationLabel = `${song.language} translation`; // demoted ex-parent; hand-polish later
    }
    writeJson(path.join(dir, "song.json"), song);
    stats.rewritten++;
  }
}

// review report: families with an "original"-labeled child that we did NOT flip
for (const [rootId, memberIds] of families) {
  if (CANONICAL_OVERRIDES[rootId]) continue;
  for (const id of memberIds) {
    const { song, label } = songs.get(id);
    if (id !== rootId && /original/i.test(song.relationLabel ?? ""))
      console.log(`REVIEW ${label}: "${song.relationLabel}" — child of ${songs.get(rootId).label}; flip? add to CANONICAL_OVERRIDES`);
  }
}

console.log(`${families.size} families: ${stats.works} works created, ${stats.skipped} already migrated, ` +
  `${stats.moved} assets moved, ${stats.deleted} duplicate copies deleted, ${stats.rewritten} song.json rewritten`);
if (s3rm.length) {
  fs.writeFileSync(path.join(ROOT, "s3-cleanup.txt"), s3rm.map(k => `aws s3 rm s3://$BUCKET/${k}`).join("\n") + "\n");
  console.log(`s3-cleanup.txt: ${s3rm.length} stale bucket keys (optional cleanup; do not commit)`);
}
