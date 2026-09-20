// Stamp conservative CCLI SongSelect ids onto packages as sources/ccli.json.
// Does not scrape lyrics or charts. Numbers come from a hand-checked list
// (tools/harvest/ccli-verified.json): title + historical author, preferring the
// SongSelect work whose slug names the standard hymn tune rather than a modern
// arrangement of the same title.
//
//   node tools/harvest/import-ccli.mjs [--dry]
// Then: node tools/build-catalog.mjs && node tools/validate.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { songDirs, idFromFolder, readJson, writeJson, readSong, writeManifest, readHarvested } from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dry = process.argv.includes("--dry");
const CCLI_RE = /^\d{4,8}$/;
const TODAY = new Date().toISOString().slice(0, 10);

const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/['’ʼ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function surnames(writer) {
  return String(writer || "").split(/\s*(?:,|&|\/| and |·|tr\.)\s*/i)
    .map(n => n.trim()).filter(Boolean)
    .map(n => n.split(/\s+/).filter(p => !/^(attr|anon|anonymous|unknown|traditional|irish|german|bohemian|8th|c)$/i.test(p)).pop())
    .filter(Boolean).map(norm);
}

function titlesMatch(a, b) {
  const na = norm(a).replace(/\s*\(.*\)$/, "");
  const nb = norm(b).replace(/\s*\(.*\)$/, "");
  if (!na || !nb) return false;
  return na === nb || (na.length >= 10 && (na.startsWith(nb) || nb.startsWith(na)));
}

function authorsOverlap(ours, theirs) {
  const a = new Set(surnames(ours));
  const b = new Set((theirs || []).flatMap(surnames));
  if (!a.size || !b.size) return false;
  for (const s of a) if (b.has(s)) return true;
  return false;
}

function ccliPath(dir) { return path.join(dir, "sources", "ccli.json"); }

function writeCcli(dir, row, source) {
  const rec = {
    ccli: String(row.ccli),
    url: `https://songselect.ccli.com/songs/${row.ccli}`,
    title: row.title,
    authors: row.authors || [],
    matchedBy: source,
    harvestedAt: TODAY
  };
  if (dry) return rec;
  fs.mkdirSync(path.join(dir, "sources"), { recursive: true });
  writeJson(ccliPath(dir), rec);
  writeManifest(dir);
  return rec;
}

const seed = readJson(path.join(ROOT, "tools", "harvest", "ccli-verified.json"));
const byId = new Map(Object.entries(seed.byId || {}));
const extras = seed.byTitleAuthor || [];

let stamped = 0, skipped = 0, extrasHit = 0;
const usedCcli = new Set();

for (const { folder, dir } of songDirs(ROOT)) {
  const id = idFromFolder(folder);
  const song = readSong(dir);
  const existing = song.ccli || readHarvested(dir).ccli;
  if (existing && CCLI_RE.test(String(existing))) { skipped++; continue; }

  const hit = byId.get(id);
  if (hit && CCLI_RE.test(hit.ccli)) {
    if (usedCcli.has(hit.ccli)) throw new Error(`CCLI ${hit.ccli} claimed twice`);
    writeCcli(dir, hit, "verified-id");
    usedCcli.add(hit.ccli);
    stamped++;
    continue;
  }

  const extra = extras.find(e => titlesMatch(song.title, e.title) && authorsOverlap(song.writer, e.authors) && CCLI_RE.test(e.ccli));
  if (extra && !usedCcli.has(extra.ccli)) {
    writeCcli(dir, extra, "verified-title-author");
    usedCcli.add(extra.ccli);
    extrasHit++;
    stamped++;
  }
}

console.log(`${dry ? "dry-run " : ""}ccli: stamped ${stamped} (extras ${extrasHit}), already had ${skipped}`);
